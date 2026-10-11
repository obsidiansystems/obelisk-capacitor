# The counter example: an Obelisk application whose portable web bundle
# (nixpkgs.webBundle.js) is what ob-capacitor wraps. Build it with
#   nix-build default.nix -A nixpkgs.webBundle.js -o result-mobile
{ system ? builtins.currentSystem
, inputs ? (
    let obelisk = import ./deps/obelisk/thunk.nix;
        nix-haskell = obelisk + "/deps/nix-haskell";
    in {
      inherit obelisk;
      inherit nix-haskell;
      nixpkgs = nix-haskell + "/pins/nixpkgs";
      reflex-dom = obelisk + "/deps/reflex-dom";
    }
  )
}:

let obelisk = import inputs.obelisk { inherit system inputs; };

in obelisk.project (import ./project.nix)
