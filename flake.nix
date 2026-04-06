{
  description = "SoulForge — Graph-powered code intelligence";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            neovim
            biome
          ];

          shellHook = ''
            echo "SoulForge dev shell ready — bun $(bun --version)"
          '';
        };
      });
}
