module Common.Route where

import Data.Functor.Identity (Identity)
import Control.Lens (Iso', iso)
import Data.Kind (Type)
import Data.Map (Map)
import Data.Map qualified as Map
import Data.Text (Text)
import Obelisk.Route
import Obelisk.Route.TH

data BackendRoute :: Type -> Type where
  BackendRoute_Api :: BackendRoute (R ApiRoute)

data ApiRoute :: Type -> Type where
  ApiRoute_Increment :: ApiRoute ()

data FrontendRoute :: Type -> Type where
  FrontendRoute_Main :: FrontendRoute ()
  FrontendRoute_Item :: FrontendRoute Text

concat <$> mapM deriveRouteComponent
  [ ''BackendRoute
  , ''ApiRoute
  , ''FrontendRoute
  ]

checkedFullRouteEncoder :: Encoder Identity Identity (R (FullRoute BackendRoute FrontendRoute)) PageName
checkedFullRouteEncoder = case checkEncoder fullRouteEncoder of
  Left e -> error $ show e
  Right x -> x

fullRouteEncoder
  :: Encoder (Either Text) Identity (R (FullRoute BackendRoute FrontendRoute)) PageName
fullRouteEncoder = mkFullRouteEncoder
  (FullRoute_Backend BackendRoute_Api :/ (ApiRoute_Increment :/ ()))
  (\case
    BackendRoute_Api -> PathSegment "api" rApiRouteEncoder)
  (\case
    FrontendRoute_Main -> PathEnd $ unitEncoder mempty
    -- The item id is a dotted identifier: it rides in a path segment (so
    -- /item/a.b is a real dotted URL) and is repeated as the q query
    -- parameter (so links and reloads carry an encoded query).
    FrontendRoute_Item -> PathSegment "item" $ isoEncoder itemPageNameIso)

rApiRouteEncoder :: Encoder (Either Text) (Either Text) (R ApiRoute) PageName
rApiRouteEncoder = pathComponentEncoder $ \case
  ApiRoute_Increment -> PathSegment "increment" $ unitEncoder mempty

itemPageNameIso :: Iso' Text PageName
itemPageNameIso = iso
  (\itemId -> ([itemId], Map.singleton "q" (Just itemId)))
  \(segs, query) -> case Map.lookup "q" query of
    Just (Just itemId) -> itemId
    _ -> case segs of
      [itemId] -> itemId
      _ -> ""

-- | Absolute URL of the counter API at the given backend origin.
apiIncrementUrl :: Text -> Text
apiIncrementUrl origin =
  origin
    <> renderBackendRoute
      checkedFullRouteEncoder
      (BackendRoute_Api :/ (ApiRoute_Increment :/ ()))
