# Build the counter example's native backend server from a DOWNLOADED web
# bundle: the frontend the backend serves is the bundle's www/ghcjs tree, so
# no frontend is cross-compiled on the native job - the exact bytes the
# runner tests are the ones the Linux bundle job produced.
#
#   nix-build examples/counter/native-backend.nix --arg bundle ./downloaded-bundle -o result-backend
#
# Needs a native GHC/Nix environment (the test host); the bundle input is an
# ordinary regular-file directory, not a Nix store path from the producer.
{ bundle
, system ? builtins.currentSystem
}:
let project = import ./default.nix { inherit system; };

    bundlePath = if builtins.isPath bundle then bundle else /. + bundle;

    # The bundle's compiled frontend, as an ordinary store package.
    bundleGhcjs = builtins.path {
      path = bundlePath + "/www/ghcjs";
      name = "counter-frontend-jsexe";
    };

    backend = project.nixpkgs.override {
      obelisk.frontend.target = "js";
      obelisk.frontend.js.optimized = bundleGhcjs;
    };

in backend.packages.backend
