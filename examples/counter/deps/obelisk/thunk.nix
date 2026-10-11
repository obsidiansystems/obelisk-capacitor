builtins.fetchGit {
  url = "https://github.com/obsidiansystems/obelisk.git";
  rev = "3d3ccbdc519070821965014771a202bf46c33ac0";
  # fetch them so the project builds exactly what its Obelisk revision built.
  submodules = true;
}
