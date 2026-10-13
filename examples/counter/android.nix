# Counter example Android runner environment.
#
#   NIXPKGS_ACCEPT_ANDROID_SDK_LICENSE=1 nix-shell examples/counter/android.nix --run 'counter-android'
#
# Provides the pinned Android SDK (compileSdk 36, build-tools 36.0.0), an
# API 35 Google APIs x86_64 emulator image, JDK 21 and Node 22, all from the
# nixpkgs pin that examples/counter already builds against. The SDK is
# immutable in the Nix store; the runner creates its own AVD state.
{ system ? builtins.currentSystem }:

# The local runner uses Linux KVM and an x86_64 system image.
assert system == "x86_64-linux"
  || throw "The counter Android runner currently requires x86_64-linux.";

let
  obelisk = import ./deps/obelisk/thunk.nix;
  nixpkgs = import (obelisk + "/deps/nix-haskell/pins/nixpkgs") { inherit system; };

  # Explicit consent for the unfree Android SDK; also settable via
  # NIXPKGS_ACCEPT_ANDROID_SDK_LICENSE=1 by androidenv's license check.
  androidenv = nixpkgs.callPackage (nixpkgs.path + "/pkgs/development/mobile/androidenv") {
    licenseAccepted = builtins.getEnv "NIXPKGS_ACCEPT_ANDROID_SDK_LICENSE" == "1";
  };

  repo = nixpkgs.lib.importJSON (nixpkgs.path + "/pkgs/development/mobile/androidenv/repo.json");
  composition = androidenv.composeAndroidPackages {
    # platformVersions also selects system images. Keep only the API 35
    # image in the catalog so compileSdk 36 does not add a second emulator.
    repo = repo // { images = { "35" = repo.images."35"; }; };
    # android-36 is the app's compileSdk (variables.gradle); android-35 is
    # what the emulator image and AVD use.
    platformVersions = [ "35" "36" ];
    # AGP 8.13 defaults to build-tools 35; use the patched aapt2 from 36.
    buildToolsVersions = [ "35.0.0" "36.0.0" ];
    cmdLineToolsVersion = "20.0";
    platformToolsVersion = "37.0.0";
    emulatorVersion = "36.5.11";
    includeEmulator = true;
    includeSystemImages = true;
    systemImageTypes = [ "google_apis" ];
    abiVersions = [ "x86_64" ];
    toolsVersion = null;
    includeCmake = false;
  };

  androidsdk = composition.androidsdk;
  androidSdkHome = "${androidsdk}/libexec/android-sdk";
  aapt2 = "${androidSdkHome}/build-tools/36.0.0/aapt2";
  systemImagePackage = "system-images;android-35;google_apis;x86_64";

  jdk = nixpkgs.jdk21;
  nodejs = nixpkgs.nodejs_22;

  counter-android = nixpkgs.writeShellScriptBin "counter-android" ''
    export ANDROID_HOME="${androidSdkHome}"
    export ANDROID_SDK_ROOT="$ANDROID_HOME"
    export JAVA_HOME="${jdk.home}"
    export COUNTER_ANDROID_AAPT2="${aapt2}"
    export COUNTER_ANDROID_SYSTEM_IMAGE="${systemImagePackage}"
    exec ${nodejs}/bin/node ${./../../scripts/run-android.mjs} "$@"
  '';
in
nixpkgs.mkShell {
  name = "counter-android";

  packages = [
    counter-android
    androidsdk
    jdk
    nodejs
    nixpkgs.nix
    nixpkgs.openssl
    nixpkgs.caddy
    nixpkgs.curl
    nixpkgs.xwayland-satellite
    nixpkgs.xauth
    nixpkgs.xdpyinfo
  ];

  JAVA_HOME = jdk.home;
  ANDROID_HOME = androidSdkHome;
  ANDROID_SDK_ROOT = androidSdkHome;
  COUNTER_ANDROID_AAPT2 = aapt2;
  COUNTER_ANDROID_SYSTEM_IMAGE = systemImagePackage;

  passthru = {
    inherit androidsdk composition;
    counter-android = counter-android;
  };
}
