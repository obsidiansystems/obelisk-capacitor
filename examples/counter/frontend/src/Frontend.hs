module Frontend where

import Control.Monad.Fix (MonadFix)
import Data.Text (Text)
import Data.Text qualified as T
import Language.Javascript.JSaddle (JSM, eval, fromJSVal, liftJSM)
import Obelisk.Configs (HasConfigs, getTextConfig)
import Obelisk.Frontend (Frontend (..), ObeliskWidget)
import Obelisk.Route (R, pattern (:/))
import Obelisk.Route.Frontend (RoutedT, routeLinkAttr, subRoute_)
import Obelisk.Generated.Static (static)
import Reflex.Dom.Core
import Common.Route

type AppWidget t m =
  ( Reflex t
  , DomBuilder t m
  , MonadFix m
  , MonadHold t m
  , PostBuild t m
  , TriggerEvent t m
  , PerformEvent t m
  , Prerender t m
  , HasConfigs m
  )
frontend :: Frontend (R FrontendRoute)
frontend = Frontend
  { _frontend_head = do
      el "title" $ text "Obelisk Pocket Counter"
      elAttr "meta" ("name" =: "viewport" <> "content" =: "width=device-width, initial-scale=1, viewport-fit=cover") blank
      elAttr "link" ("rel" =: "stylesheet" <> "href" =: (static @"css/main.css")) blank
  , _frontend_body = elClass "main" "app" $ do
      elClass "header" "brand" $ do
        logoWidget
        el "span" $ text "obelisk"
        elClass "span" "edition" $ text "CAPACITOR"
      subRoute_ $ \case
        FrontendRoute_Main -> home
        FrontendRoute_Item -> itemPage
      navLinks
  }

-- Route links address the full route, so they live outside subRoute_.
navLinks :: ObeliskWidget t (R FrontendRoute) m => RoutedT t (R FrontendRoute) m ()
navLinks = elAttr "nav" ("class" =: "routes" <> "aria-label" =: "App routes") $ do
  routeLinkAttr ("id" =: "link-main") (FrontendRoute_Main :/ ()) $ text "Counter"
  routeLinkAttr ("id" =: "link-item") (FrontendRoute_Item :/ "a.b") $ text "Item a.b"

-- | A clickable button with the given DOM id.
buttonWithId :: DomBuilder t m => Text -> Text -> m (Event t ())
buttonWithId ident label = do
  (e, ()) <- elAttr' "button" ("id" =: ident <> "type" =: "button") $ text label
  pure $ domEvent Click e

-- The count and goal remain mounted while the browser scrolls between cards.
-- Native range input events and button events feed the same Reflex graph.
counterWidget :: AppWidget t m => m ()
counterWidget = mdo
  elClass "div" "card-heading" $ do
    elClass "span" "eyebrow" $ text "01 / LOCAL STATE"
    elClass "span" "tag" $ text "OFFLINE"
  el "h2" $ text "Make it count."
  let ringAttrs = zipDynWith (\n g ->
        "class" =: "counter-ring" <> "style" =:
          ("--count:" <> T.pack (show n) <> ";--goal:" <> g)) count (_inputElement_value goal)
  elDynAttr "div" ringAttrs $ elClass "div" "ring-center" $ do
    elAttr "output" ("id" =: "count" <> "aria-live" =: "polite") $ dynText $ T.pack . show <$> count
    elClass "span" "count-unit" $ text "TAPS"
  (clicked, reset) <- elClass "div" "counter-actions" $ do
    incremented <- buttonWithId "counter-inc" "+ Increment"
    cleared <- buttonWithId "counter-reset" "Reset"
    pure (incremented, cleared)
  count <- foldDyn ($) (0 :: Int) $ leftmost [(+ 1) <$ clicked, const 0 <$ reset]
  elClass "div" "goal-label" $ do
    elAttr "label" ("for" =: "counter-goal") $ text "Tap goal"
    elAttr "output" ("id" =: "goal-value" <> "for" =: "counter-goal") $ dynText $ _inputElement_value goal
  goal <- inputElement $ def
    & inputElementConfig_initialValue .~ "12"
    & inputElementConfig_elementConfig . elementConfig_initialAttributes .~
        ("id" =: "counter-goal" <> "type" =: "range" <>
         "min" =: "4" <> "max" =: "24" <> "step" =: "1")
  elClass "p" "card-note" $ text "Drag the goal. The ring follows."

-- | Config-driven render: the public config baked into the bundle decides
-- what the page shows.
configWidget :: AppWidget t m => m ()
configWidget = do
  mRoute <- getTextConfig "common/route"
  elAttr "p" ("id" =: "backend-origin") $ text $ case mRoute of
    Nothing -> "common/route: not configured"
    Just r -> "common/route: " <> T.strip r

-- | The hashed static asset: served under its content-hashed URL from
-- static/, exactly as Obelisk.Generated.Static addresses it.
logoWidget :: AppWidget t m => m ()
logoWidget =
  elAttr "img" ("id" =: "logo" <> "src" =: (static @"img/logo.svg") <> "alt" =: "" <> "width" =: "32" <> "height" =: "32") blank

-- One JS-side request is issued as soon as the bridge is available; the
-- native Promise stores its result (or its rejection) on globalThis, which
-- the Haskell side polls. Nothing is caught or defaulted: a rejected call
-- shows up as an error line in the page.
deviceScript :: Text
deviceScript = "(function(){var o=globalThis.ObeliskCapacitor;if(!(o&&o.Device)){return 'bridge unavailable';}var s=globalThis.__obCounterDevice;if(!s){s={pending:false,info:null};globalThis.__obCounterDevice=s;}if(!s.pending&&!s.info){s.pending=true;o.Device.getInfo().then(function(r){s.info=r;s.pending=false;},function(e){s.info={platform:'error',osVersion:String(e),operatingSystem:'error',model:''};s.pending=false;});}if(s.info){return 'platform='+String(s.info.platform)+' os='+String(s.info.operatingSystem)+' '+String(s.info.osVersion)+' model='+String(s.info.model);}return 'pending';})()"

pollDeviceInfo :: JSM Text
pollDeviceInfo = do
  v <- eval deviceScript
  r <- fromJSVal v
  pure $ case r of
    Just t -> t
    Nothing -> "bridge result unparseable"

-- | Real @Device.getInfo()@ through the ObeliskCapacitor bridge, polled
-- until the native Promise settles.
deviceWidget
  :: AppWidget t m => m ()
deviceWidget = do
  elClass "div" "card-heading" $ do
    elClass "span" "eyebrow" $ text "03 / NATIVE BRIDGE"
    elClass "span" "tag" $ text "DEVICE"
  el "h2" $ text "Meet your phone."
  elAttr "div" ("class" =: "device-art" <> "aria-hidden" =: "true") $
    elClass "div" "device-screen" $ text "OC"
  elClass "p" "card-description" $ text "Native device info, called from Haskell."
  prerender_
    (elAttr "p" ("id" =: "device-result") (text "device info loads on the client"))
    (do
      clicked <- buttonWithId "device-btn" "Device.getInfo()"
      ticked <- tickLossyFromPostBuildTime 0.15
      let go = leftmost [clicked, () <$ ticked]
      result <- performEvent $ ffor go $ \() -> liftJSM pollDeviceInfo
      d <- holdDyn "waiting for the ObeliskCapacitor bridge" result
      elAttr "p" ("id" =: "device-result") $ dynText d)

-- | Real cross-origin request to the Obelisk backend at the configured
-- origin. Missing or invalid configuration is visible in the page; it never
-- falls back to the WebView's own origin.
backendWidget
  :: AppWidget t m => m ()
backendWidget = do
  elClass "div" "card-heading" $ do
    elClass "span" "eyebrow" $ text "02 / HTTPS BACKEND"
    elClass "span" "tag" $ text "XHR"
  el "h2" $ text "Take it online."
  elAttr "div" ("class" =: "backend-art" <> "aria-hidden" =: "true") $ do
    el "span" $ text "APP"
    elClass "span" "connection" $ text "POST"
    el "span" $ text "API"
  elClass "p" "card-description" $ text "A real request. A separate server-side count."
  mOrigin <- getTextConfig "common/route"
  let originOk = case T.strip <$> mOrigin of
        Just o
          | not (T.null o)
          , "https://" `T.isPrefixOf` o || "http://" `T.isPrefixOf` o ->
              Just o
        _ -> Nothing
  prerender_
    (elAttr "p" ("id" =: "backend-result") (text "backend requests run on the client"))
    (do
      clicked <- buttonWithId "backend-inc" "POST /api/increment"
      case originOk of
        Nothing -> elAttr "p" ("id" =: "backend-result") $ text $ case mOrigin of
          Nothing -> "common/route not configured: refusing to guess a backend origin"
          Just o -> "invalid common/route " <> o <> ": refusing to guess a backend origin"
        Just origin -> do
          let req = XhrRequest "POST" (apiIncrementUrl origin) $ def
                { _xhrRequestConfig_headers = "Content-Type" =: "application/json"
                , _xhrRequestConfig_sendData = "{}" :: Text
                }
          resp <- performRequestAsync (req <$ clicked)
          d <- holdDyn "not requested yet" (describeResponse <$> resp)
          elAttr "p" ("id" =: "backend-result") $ dynText d)

describeResponse :: XhrResponse -> Text
describeResponse r =
  "HTTP " <> T.pack (show (_xhrResponse_status r)) <> " " <> maybe "(no body)" id (_xhrResponse_responseText r)

home :: AppWidget t m => m ()
home = do
  elClass "header" "intro" $ do
    el "h1" $ text "Pocket counter"
    el "p" $ text "Haskell in the palm of your hand."
  -- CSS scroll snap keeps gestures native and does not rebuild card state.
  elAttr "div" ("class" =: "cards" <> "aria-label" =: "Swipeable demos" <> "tabindex" =: "0") $ do
    elAttr "section" ("class" =: "card local-card" <> "aria-label" =: "Local counter") counterWidget
    elAttr "section" ("class" =: "card backend-card" <> "aria-label" =: "Backend") backendWidget
    elAttr "section" ("class" =: "card device-card" <> "aria-label" =: "Native device") deviceWidget
  elClass "p" "swipe-hint" $ text "Swipe to explore  /  3 live demos"
  elClass "details" "diagnostics" $ do
    el "summary" $ text "Connection details"
    configWidget
    elAttr "p" ("id" =: "home-marker") $ text "route: main"

itemPage :: AppWidget t m => m ()
itemPage = elClass "section" "route-detail" $ do
  elClass "p" "eyebrow" $ text "TYPED ROUTING"
  el "h1" $ text "Item a.b"
  el "p" $ text "A dotted path, a real route. Use Android Back or Counter to return."
  elAttr "p" ("id" =: "item-marker") $ text "route: item"
