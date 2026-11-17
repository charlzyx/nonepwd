// Command buildplugin compiles crates/nonepwd-core into a macOS cdylib and
// stores it into apps/desktop/npcore/build/darwin/libnonepwd_core.dylib via
// Asuka's plugin.StoreBuild.
package main

import (
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/egoist/asuka/plugin"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "buildplugin error: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	wd, err := os.Getwd()
	if err != nil {
		return err
	}
	// Support running from apps/desktop or repo root.
	desktopDir := wd
	if _, err := os.Stat(filepath.Join(wd, "apps", "desktop", "asuka.json")); err == nil {
		desktopDir = filepath.Join(wd, "apps", "desktop")
	}
	repoRoot := filepath.Clean(filepath.Join(desktopDir, "..", ".."))
	coreCrateDir := filepath.Join(repoRoot, "crates", "nonepwd-core")
	pluginDir := filepath.Join(desktopDir, "npcore")

	manifestPath := filepath.Join(pluginDir, plugin.ManifestFile)
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		return fmt.Errorf("read %s: %w", manifestPath, err)
	}
	manifest, err := plugin.Parse(manifestBytes)
	if err != nil {
		return fmt.Errorf("parse manifest: %w", err)
	}

	dylibBytes, err := buildCoreDylib(repoRoot, coreCrateDir)
	if err != nil {
		return err
	}

	srcHash, err := plugin.SourceHash(pluginDir, manifest)
	if err != nil {
		return fmt.Errorf("compute plugin SourceHash: %w", err)
	}

	if err := plugin.StoreBuild(pluginDir, "darwin", "libnonepwd_core.dylib", dylibBytes, srcHash); err != nil {
		return fmt.Errorf("StoreBuild: %w", err)
	}

	outPath := plugin.BuildPath(pluginDir, "darwin", "libnonepwd_core.dylib")
	fmt.Printf("Stored Asuka plugin dylib: %s (%d bytes, source=%s)\n", outPath, len(dylibBytes), srcHash[:12])
	return nil
}

func buildCoreDylib(repoRoot, coreCrateDir string) ([]byte, error) {
	targetDir, err := os.MkdirTemp("", "npcore-cargo-target-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(targetDir)

	manifestPath := filepath.Join(coreCrateDir, "Cargo.toml")
	cmd := exec.Command("cargo", "build", "--manifest-path", manifestPath, "--release", "--offline", "--target-dir", targetDir)
	if out, err := cmd.CombinedOutput(); err == nil {
		return os.ReadFile(filepath.Join(targetDir, "release", "libnonepwd_core.dylib"))
	} else {
		// Fallback when another workspace crate is mid-scaffold: build an isolated copy of nonepwd-core with Cargo.lock.
		dylib, fbErr := buildIsolatedCopy(repoRoot, coreCrateDir, targetDir)
		if fbErr != nil {
			return nil, fmt.Errorf("cargo build failed: %s (fallback error: %v)", strings.TrimSpace(string(out)), fbErr)
		}
		return dylib, nil
	}
}

func buildIsolatedCopy(repoRoot, coreCrateDir, targetDir string) ([]byte, error) {
	tmpCrate, err := os.MkdirTemp("", "npcore-isolated-*")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(tmpCrate)

	if err := copyDir(coreCrateDir, tmpCrate); err != nil {
		return nil, err
	}
	cargoTomlPath := filepath.Join(tmpCrate, "Cargo.toml")
	cargoToml, err := os.ReadFile(cargoTomlPath)
	if err != nil {
		return nil, err
	}
	if !strings.Contains(string(cargoToml), "[workspace]") {
		cargoToml = append(cargoToml, []byte("\n[workspace]\n")...)
		if err := os.WriteFile(cargoTomlPath, cargoToml, 0o644); err != nil {
			return nil, err
		}
	}
	if lockBytes, err := os.ReadFile(filepath.Join(repoRoot, "Cargo.lock")); err == nil {
		_ = os.WriteFile(filepath.Join(tmpCrate, "Cargo.lock"), lockBytes, 0o644)
	}
	if cargoCfg, err := os.ReadFile(filepath.Join(repoRoot, ".cargo", "config.toml")); err == nil {
		_ = os.MkdirAll(filepath.Join(tmpCrate, ".cargo"), 0o755)
		_ = os.WriteFile(filepath.Join(tmpCrate, ".cargo", "config.toml"), cargoCfg, 0o644)
	}

	cmd := exec.Command("cargo", "build", "--manifest-path", cargoTomlPath, "--release", "--offline", "--target-dir", targetDir)
	if out, err := cmd.CombinedOutput(); err != nil {
		return nil, fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return os.ReadFile(filepath.Join(targetDir, "release", "libnonepwd_core.dylib"))
}

func copyDir(src, dst string) error {
	return filepath.WalkDir(src, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(src, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}
