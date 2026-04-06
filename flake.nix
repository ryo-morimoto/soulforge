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
        lib = pkgs.lib;

        version = "2.6.5";

        # Fixed-Output Derivation: bun install runs with network access,
        # output is content-addressed by hash.
        # To update: change the hash to lib.fakeHash, run `nix build`,
        # copy the correct hash from the error message.
        bunDeps = pkgs.stdenv.mkDerivation {
          pname = "soulforge-deps";
          inherit version;

          src = lib.fileset.toSource {
            root = ./.;
            fileset = lib.fileset.unions [
              ./package.json
              ./bun.lock
            ];
          };

          nativeBuildInputs = [ pkgs.bun ];

          outputHashAlgo = "sha256";
          outputHashMode = "recursive";
          outputHash = "sha256-q1oA7EOCdHbV1nl2ljv9z4lujVOeCvNmoat0GcvoIR8=";

          impureEnvVars = lib.fetchers.proxyImpureEnvVars;

          buildPhase = ''
            export HOME=$(mktemp -d)
            bun install --frozen-lockfile
          '';

          installPhase = ''
            cp -r node_modules $out
          '';
        };

        runtimeDeps = with pkgs; [ bun neovim ];

        soulforge = pkgs.stdenv.mkDerivation {
          pname = "soulforge";
          inherit version;
          src = ./.;

          nativeBuildInputs = with pkgs; [ bun makeWrapper ];

          buildPhase = ''
            export HOME=$(mktemp -d)

            cp -r ${bunDeps} node_modules
            chmod -R u+w node_modules

            bun scripts/build.ts
          '';

          installPhase = ''
            mkdir -p $out/lib/soulforge $out/bin

            # dist output (index.js, workers, opentui-assets, init.lua)
            cp -r dist/* $out/lib/soulforge/

            # node_modules needed at runtime for native addons
            cp -r node_modules $out/lib/soulforge/

            # Wrapper: bun runs the bundled index.js with runtime deps on PATH
            makeWrapper ${pkgs.bun}/bin/bun $out/bin/soulforge \
              --add-flags "$out/lib/soulforge/index.js" \
              --prefix PATH : ${lib.makeBinPath runtimeDeps}

            ln -s $out/bin/soulforge $out/bin/sf
          '';
        };
      in
      {
        packages = {
          default = soulforge;
          inherit soulforge;
        };

        apps.default = {
          type = "app";
          program = "${soulforge}/bin/soulforge";
        };

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
