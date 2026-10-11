module Frontend where

import Control.Monad.Fix (MonadFix)
import Data.Text (Text)
import Data.Text qualified as T
import Language.Javascript.JSaddle (JSM, MonadJSM, eval, fromJSVal, liftJSM)
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
      el "title" $ text "Obelisk Capacitor Counter"
      elAttr "link" ("rel" =: "stylesheet" <> "href" =: (static @"css/main.css")) blank
  , _frontend_body = do
      navLinks
      subRoute_ $ \case
        FrontendRoute_Main -> home
        FrontendRoute_Item -> itemPage
  }

-- Route links address the full route, so they live outside subRoute_.
navLinks :: ObeliskWidget t (R FrontendRoute) m => RoutedT t (R FrontendRoute) m ()
navLinks = el "p" $ do
  routeLinkAttr ("id" =: "link-main") (FrontendRoute_Main :/ ()) $ text "home"
  text " "
  routeLinkAttr ("id" =: "link-item") (FrontendRoute_Item :/ "a.b") $ text "item a.b"

-- | A clickable button with the given DOM id.
buttonWithId :: DomBuilder t m => Text -> Text -> m (Event t ())
buttonWithId ident label = do
  (e, ()) <- elAttr' "button" ("id" =: ident <> "type" =: "button") $ text label
  pure $ domEvent Click e

-- | The local counter: 0 at boot, +1 per tap, no backend involved.
counterWidget :: AppWidget t m => m ()
counterWidget = do
  el "h2" $ text "Local counter"
  clicked <- buttonWithId "counter-inc" "Increment"
  count <- foldDyn (\_ -> (+ 1)) (0 :: Int) clicked
  elAttr "p" ("id" =: "count") $ dynText $ T.pack . show <$> count

-- | Config-driven render: the public config baked into the bundle decides
-- what the page shows.
configWidget :: AppWidget t m => m ()
configWidget = do
  mRoute <- getTextConfig "common/route"
  elAttr "p" ("id" =: "backend-origin") $ text $ case mRoute of
    Nothing -> "common/route: not configured"
    Just r -> "common/route: " <> r

-- | The hashed static asset: served under its content-hashed URL from
-- static/, exactly as Obelisk.Generated.Static addresses it.
logoWidget :: AppWidget t m => m ()
logoWidget =
  elAttr "img" ("id" =: "logo" <> "src" =: (static @"img/logo.svg") <> "alt" =: "obelisk logo" <> "width" =: "96") blank

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
  el "h2" $ text "Device"
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
  el "h2" $ text "Backend"
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
  el "h1" $ text "Obelisk Capacitor Counter"
  configWidget
  logoWidget
  counterWidget
  deviceWidget
  backendWidget
  el "h2" $ text "Routes"
  elAttr "p" ("id" =: "home-marker") $ text "route: main"

itemPage :: AppWidget t m => m ()
itemPage = do
  el "h1" $ text "Item"
  elAttr "p" ("id" =: "item-marker") $ text "route: item"
