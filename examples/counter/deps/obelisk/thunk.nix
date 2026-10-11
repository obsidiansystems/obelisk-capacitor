builtins.fetchGit {
  url = "https://github.com/obsidiansystems/obelisk.git";
  rev = "899032f421dd8d34a7a6badab833df0d14f01ea9";
  # fetch them so the project builds exactly what its Obelisk revision built.
  submodules = true;
}
