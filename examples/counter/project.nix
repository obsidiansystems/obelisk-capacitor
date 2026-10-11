{ pkgs, obeliskLib, ... }:

{

  name = "obelisk-counter-app";
  src = ./.;

  inherit (obeliskLib) source-repository-packages;

  # Plain source tree: no build step, hashed straight from src/.
  obelisk.static.path = ./static/src;

  # Public config (common/ + frontend/) is bundled into the production server
  # and the portable web bundle; backend/ is never bundled.
  obelisk.config.path = ./config;

  shell = {
    crossPlatforms = ps: with ps; [
      wasi32

      # The mobile bundle targets JavaScript:
      #   cabal build/repl/run backend -f js
      #   ob-run/ob-repl -f js
      ghcjs
    ];
    withHoogle = false;
  };

}
