module Backend where

import Control.Monad.IO.Class (liftIO)
import Data.ByteString (ByteString)
import Obelisk.Route (pattern (:/))
import Data.IORef (IORef, modifyIORef', newIORef, readIORef)
import Data.String (fromString)
import Obelisk.Backend
import Snap.Core
  ( Method (OPTIONS, POST)
  , Snap
  , getHeader

  , getsRequest
  , method
  , modifyResponse
  , setHeader
  , setResponseCode
  , writeText
  )
import System.FilePath ((</>))

import Common
import Frontend
import Paths (dataDir)

backend :: Backend BackendRoute FrontendRoute
backend = Backend
  { _backend_run = \serve -> do
      count <- newIORef (0 :: Int)
      serve $ \case
        BackendRoute_Api :/ (ApiRoute_Increment :/ ()) -> apiIncrement count
  , _backend_routeEncoder = fullRouteEncoder
  }

-- | Cross-origin access is granted to precisely Capacitor's two local
-- origins and nothing else. Web sessions and arbitrary hosts are not
-- allowed; deploy a reverse proxy with your own auth for anything wider.
allowedOrigins :: [ByteString]
allowedOrigins = ["capacitor://localhost", "https://localhost"]

apiIncrement :: IORef Int -> Snap ()
apiIncrement count = do
  mOrigin <- getsRequest (getHeader "Origin")
  let originAllowed = case mOrigin of
        Just o | o `elem` allowedOrigins -> Just o
        _ -> Nothing
  method OPTIONS $ case originAllowed of
    Nothing -> modifyResponse $ setResponseCode 403
    Just origin -> do
      modifyResponse $ setResponseCode 204
      modifyResponse $ setHeader "Access-Control-Allow-Origin" origin
      modifyResponse $ setHeader "Access-Control-Allow-Methods" "POST, OPTIONS"
      modifyResponse $ setHeader "Access-Control-Allow-Headers" "Content-Type"
      modifyResponse $ setHeader "Access-Control-Max-Age" "600"
      modifyResponse $ setHeader "Vary" "Origin"
  method POST $ case originAllowed of
    Nothing -> modifyResponse $ setResponseCode 403
    Just origin -> do
      n <- liftIO (modifyIORef' count (+ 1) >> readIORef count)
      modifyResponse $ setHeader "Access-Control-Allow-Origin" origin
      modifyResponse $ setHeader "Vary" "Origin"
      writeText ("{\"count\":" <> fromString (show n) <> "}")

-- | Serve the app. This is the entry point of the backend executable, so it
-- is what @ob-run@ relinks and restarts on each change; under @ob-repl@ it
-- is in scope and can be called by hand.
run :: IO ()
run = runBackendWith config backend frontend
  where
    config = BackendConfig
      { _backendConfig_runSnap = runSnapWithCommandLineArgs
      , _backendConfig_staticAssets = StaticAssets
          { _staticAssets_processed = dataDir </> "static.assets"
          , _staticAssets_unprocessed = dataDir </> "static"
          }
      , _backendConfig_frontendGhcjsAssets = StaticAssets
          { _staticAssets_processed = dataDir </> "frontend.jsexe.assets"
          , _staticAssets_unprocessed = dataDir </> "frontend.jsexe"
          }
      , _backendConfig_ghcjsWidgets = defaultGhcjsWidgets
      }
