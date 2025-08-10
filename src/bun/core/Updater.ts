import { join, dirname, resolve, basename } from "path";
import { homedir } from "os";
import { renameSync, unlinkSync, mkdirSync, rmdirSync, statSync, readdirSync, cpSync } from "fs";
import { execSync } from "child_process";
import tar from "tar";
import { ZstdInit } from "@oneidentity/zstd-js/wasm";
import { OS as currentOS, ARCH as currentArch } from '../../shared/platform';
import { native } from '../proc/native';

// setTimeout(async () => {
//   console.log('killing')
//   const { native } = await import('../proc/native');
//             native.symbols.killApp();
// }, 1000)

// Cross-platform app data directory
function getAppDataDir(): string {
  switch (currentOS) {
    case 'macos':
      return join(homedir(), "Library", "Application Support");
    case 'win':
      // Use LOCALAPPDATA to match extractor location
      return process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local");
    case 'linux':
      // Use XDG_DATA_HOME or fallback to ~/.local/share to match extractor
      return process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
    default:
      // Fallback to home directory with .config
      return join(homedir(), ".config");
  }
}

// todo (yoav): share type with cli
let localInfo: {
  version: string;
  hash: string;
  bucketUrl: string;
  channel: string;
  name: string;
  identifier: string;
};

let updateInfo: {
  version: string;
  hash: string;
  updateAvailable: boolean;
  updateReady: boolean;
  error: string;
};

const Updater = {
  // workaround for some weird state stuff in this old version of bun
  // todo: revisit after updating to the latest bun
  updateInfo: () => {
    return updateInfo;
  },
  // todo: allow switching channels, by default will check the current channel
  checkForUpdate: async () => {
    const localInfo = await Updater.getLocallocalInfo();

    if (localInfo.channel === "dev") {
      return {
        version: localInfo.version,
        hash: localInfo.hash,
        updateAvailable: false,
        updateReady: false,
        error: "",
      };
    }

    const channelBucketUrl = await Updater.channelBucketUrl();
    const cacheBuster = Math.random().toString(36).substring(7);
    const platformFolder = `${localInfo.channel}-${currentOS}-${currentArch}`;
    const updateInfoUrl = join(localInfo.bucketUrl, platformFolder, `update.json?${cacheBuster}`);

    try {
      const updateInfoResponse = await fetch(updateInfoUrl);

      if (updateInfoResponse.ok) {
        // todo: this seems brittle
        updateInfo = await updateInfoResponse.json();

        if (updateInfo.hash !== localInfo.hash) {
          updateInfo.updateAvailable = true;
        }
      } else {
        return {
          version: "",
          hash: "",
          updateAvailable: false,
          updateReady: false,
          error: `Failed to fetch update info from ${updateInfoUrl}`,
        };
      }
    } catch (error) {
      return {
        version: "",
        hash: "",
        updateAvailable: false,
        updateReady: false,
        error: `Failed to fetch update info from ${updateInfoUrl}`,
      };
    }

    return updateInfo;
  },

  downloadUpdate: async () => {
    const appDataFolder = await Updater.appDataFolder();
    const channelBucketUrl = await Updater.channelBucketUrl();
    const appFileName = localInfo.name;

    let currentHash = (await Updater.getLocallocalInfo()).hash;
    let latestHash = (await Updater.checkForUpdate()).hash;

    const extractionFolder = join(appDataFolder, "self-extraction");
    if (!(await Bun.file(extractionFolder).exists())) {
      mkdirSync(extractionFolder, { recursive: true });
    }

    let currentTarPath = join(extractionFolder, `${currentHash}.tar`);
    const latestTarPath = join(extractionFolder, `${latestHash}.tar`);

    const seenHashes = [];

    // todo (yoav): add a check to the while loop that checks for a hash we've seen before
    // so that update loops that are cyclical can be broken
    if (!(await Bun.file(latestTarPath).exists())) {
      while (currentHash !== latestHash) {
        seenHashes.push(currentHash);
        const currentTar = Bun.file(currentTarPath);

        if (!(await currentTar.exists())) {
          // tar file of the current version not found
          // so we can't patch it. We need the byte-for-byte tar file
          // so break out and download the full version
          break;
        }

        // check if there's a patch file for it
        const platformFolder = `${localInfo.channel}-${currentOS}-${currentArch}`;
        const patchResponse = await fetch(
          join(localInfo.bucketUrl, platformFolder, `${currentHash}.patch`)
        );

        if (!patchResponse.ok) {
          // patch not found
          break;
        }

        // The patch file's name is the hash of the "from" version
        const patchFilePath = join(
          appDataFolder,
          "self-extraction",
          `${currentHash}.patch`
        );
        await Bun.write(patchFilePath, await patchResponse.arrayBuffer());
        // patch it to a tmp name
        const tmpPatchedTarFilePath = join(
          appDataFolder,
          "self-extraction",
          `from-${currentHash}.tar`
        );

        // Note: cwd should be Contents/MacOS/ where the binaries are in the amc app bundle
        try {
          Bun.spawnSync([
            "bspatch",
            currentTarPath,
            tmpPatchedTarFilePath,
            patchFilePath,
          ]);
        } catch (error) {
          break;
        }

        let versionSubpath = "";
        const untarDir = join(appDataFolder, "self-extraction", "tmpuntar");
        mkdirSync(untarDir, { recursive: true });

        // extract just the version.json from the patched tar file so we can see what hash it is now
        const resourcesDir = 'Resources'; // Always use capitalized Resources
        await tar.x({
          // gzip: false,
          file: tmpPatchedTarFilePath,
          cwd: untarDir,
          filter: (path, stat) => {
            if (path.endsWith(`${resourcesDir}/version.json`)) {
              versionSubpath = path;
              return true;
            } else {
              return false;
            }
          },
        });

        const currentVersionJson = await Bun.file(
          join(untarDir, versionSubpath)
        ).json();
        const nextHash = currentVersionJson.hash;

        if (seenHashes.includes(nextHash)) {
          console.log("Warning: cyclical update detected");
          break;
        }

        seenHashes.push(nextHash);

        if (!nextHash) {
          break;
        }
        // Sync the patched tar file to the new hash
        const updatedTarPath = join(
          appDataFolder,
          "self-extraction",
          `${nextHash}.tar`
        );
        renameSync(tmpPatchedTarFilePath, updatedTarPath);

        // delete the old tar file
        unlinkSync(currentTarPath);
        unlinkSync(patchFilePath);
        rmdirSync(untarDir, { recursive: true });

        currentHash = nextHash;
        currentTarPath = join(
          appDataFolder,
          "self-extraction",
          `${currentHash}.tar`
        );
        // loop through applying patches until we reach the latest version
        // if we get stuck then exit and just download the full latest version
      }

      // If we weren't able to apply patches to the current version,
      // then just download it and unpack it
      if (currentHash !== latestHash) {
        const cacheBuster = Math.random().toString(36).substring(7);
        const platformFolder = `${localInfo.channel}-${currentOS}-${currentArch}`;
        // Platform-specific tarball naming
        let tarballName: string;
        if (currentOS === 'macos') {
          tarballName = `${appFileName}.app.tar.zst`;
        } else if (currentOS === 'win') {
          tarballName = `${appFileName}.tar.zst`;
        } else {
          tarballName = `${appFileName}.tar.zst`;
        }
        
        const urlToLatestTarball = join(
          localInfo.bucketUrl,
          platformFolder,
          tarballName
        );
        const prevVersionCompressedTarballPath = join(
          appDataFolder,
          "self-extraction",
          "latest.tar.zst"
        );
        const response = await fetch(urlToLatestTarball + `?${cacheBuster}`);

        if (response.ok && response.body) {
          const reader = response.body.getReader();

          const writer = Bun.file(prevVersionCompressedTarballPath).writer();

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
          }
          await writer.flush();
          writer.end();
        } else {
          console.log("latest version not found at: ", urlToLatestTarball);
        }

        await ZstdInit().then(async ({ ZstdSimple }) => {
          const data = new Uint8Array(
            await Bun.file(prevVersionCompressedTarballPath).arrayBuffer()
          );
          const uncompressedData = ZstdSimple.decompress(data);

          await Bun.write(latestTarPath, uncompressedData);
        });

        unlinkSync(prevVersionCompressedTarballPath);
        try {
          unlinkSync(currentTarPath);
        } catch (error) {
          // Note: ignore the error. it may have already been deleted by the patching process
          // if the patching process only got halfway
        }
      }
    }

    // Note: Bun.file().exists() caches the result, so we nee d an new instance of Bun.file() here
    // to check again
    if (await Bun.file(latestTarPath).exists()) {
      // download patch for this version, apply it.
      // check for patch from that tar and apply it, until it matches the latest version
      // as a fallback it should just download and unpack the latest version
      updateInfo.updateReady = true;
    } else {
      updateInfo.error = "Failed to download latest version";
    }
  },

  // todo (yoav): this should emit an event so app can cleanup or block the restart
  // todo (yoav): rename this to quitAndApplyUpdate or something
  applyUpdate: async () => {
    if (updateInfo?.updateReady) {
      const appDataFolder = await Updater.appDataFolder();
      const extractionFolder = join(appDataFolder, "self-extraction");
      if (!(await Bun.file(extractionFolder).exists())) {
        mkdirSync(extractionFolder, { recursive: true });
      }

      let latestHash = (await Updater.checkForUpdate()).hash;
      const latestTarPath = join(extractionFolder, `${latestHash}.tar`);

      let appBundleSubpath: string = "";

      if (await Bun.file(latestTarPath).exists()) {
        // Windows needs a temporary directory to avoid file locking issues
        const extractionDir = currentOS === 'win' 
          ? join(extractionFolder, `temp-${latestHash}`)
          : extractionFolder;
        
        if (currentOS === 'win') {
          mkdirSync(extractionDir, { recursive: true });
        }
        
        // Use Windows native tar.exe on Windows due to npm tar library issues (same as CLI)
        if (currentOS === 'win') {
          console.log(`Using Windows native tar.exe to extract ${latestTarPath} to ${extractionDir}...`);
          try {
            execSync(`tar -xf "${latestTarPath}" -C "${extractionDir}"`, { 
              stdio: 'inherit',
              cwd: extractionDir 
            });
            console.log('Windows tar.exe extraction completed successfully');
            
            // For Windows/Linux, the app bundle is at root level
            appBundleSubpath = "./";
          } catch (error) {
            console.error('Windows tar.exe extraction failed:', error);
            throw error;
          }
        } else {
          // Use npm tar library on macOS/Linux (keep original behavior)
          await tar.x({
            // gzip: false,
            file: latestTarPath,
            cwd: extractionDir,
            onentry: (entry) => {
              if (currentOS === 'macos') {
                // find the first .app bundle in the tarball
                // Some apps may have nested .app bundles
                if (!appBundleSubpath && entry.path.endsWith(".app/")) {
                  appBundleSubpath = entry.path;
                }
              } else {
                // For Linux, look for the main executable
                if (!appBundleSubpath) {
                  appBundleSubpath = "./";
                }
              }
            },
          });
        }
        
        console.log(`Tar extraction completed. Found appBundleSubpath: ${appBundleSubpath}`);

        if (!appBundleSubpath) {
          console.error("Failed to find app in tarball");
          return;
        }

        // Note: resolve here removes the extra trailing / that the tar file adds
        const extractedAppPath = resolve(
          join(extractionDir, appBundleSubpath)
        );
        
        // Platform-specific path handling
        let newAppBundlePath: string;
        if (currentOS === 'linux' || currentOS === 'win') {
          // On Linux/Windows, the actual app is inside a subdirectory
          // Use same sanitization as extractor: remove spaces and dots
          // Note: localInfo.name already includes the channel (e.g., "test1-canary")
          const appBundleName = localInfo.name.replace(/ /g, "").replace(/\./g, "-");
          newAppBundlePath = join(extractionDir, appBundleName);
          
          // Verify the extracted app exists
          if (!statSync(newAppBundlePath, { throwIfNoEntry: false })) {
            console.error(`Extracted app not found at: ${newAppBundlePath}`);
            console.log("Contents of extraction directory:");
            try {
              const files = readdirSync(extractionDir);
              for (const file of files) {
                console.log(`  - ${file}`);
              }
            } catch (e) {
              console.log("Could not list directory contents:", e);
            }
            return;
          }
        } else {
          // On macOS, use the extracted app path directly
          newAppBundlePath = extractedAppPath;
        }
        // Platform-specific app path calculation
        let runningAppBundlePath: string;
        if (currentOS === 'macos') {
          // On macOS, executable is at Contents/MacOS/binary inside .app bundle
          runningAppBundlePath = resolve(
            dirname(process.execPath),
            "..",
            ".."
          );
        } else {
          // On Linux/Windows, calculate app path using app data directory structure
          const appDataFolder = await Updater.appDataFolder();
          if (currentOS === 'linux') {
            runningAppBundlePath = join(appDataFolder, "app");
          } else {
            // On Windows, use versioned app folders
            const currentHash = (await Updater.getLocallocalInfo()).hash;
            runningAppBundlePath = join(appDataFolder, `app-${currentHash}`);
          }
        }
        // Platform-specific backup handling
        let backupPath: string;
        if (currentOS === 'macos') {
          // On macOS, backup in extraction folder with .app extension
          backupPath = join(extractionFolder, "backup.app");
        } else {
          // On Linux/Windows, create a tar backup of the current app
          backupPath = join(extractionFolder, "backup.tar");
        }

        try {
          if (currentOS === 'macos') {
            // On macOS, use rename approach
            // Remove existing backup if it exists
            if (statSync(backupPath, { throwIfNoEntry: false })) {
              rmdirSync(backupPath, { recursive: true });
            }
            
            // Move current running app to backup
            renameSync(runningAppBundlePath, backupPath);
            
            // Move new app to running location
            renameSync(newAppBundlePath, runningAppBundlePath);
          } else if (currentOS === 'linux') {
            // On Linux, create tar backup and replace
            // Remove existing backup.tar if it exists
            if (statSync(backupPath, { throwIfNoEntry: false })) {
              unlinkSync(backupPath);
            }
            
            // Create tar backup of current app
            await tar.c(
              {
                file: backupPath,
                cwd: dirname(runningAppBundlePath),
              },
              [basename(runningAppBundlePath)]
            );
            
            // Remove current app
            rmdirSync(runningAppBundlePath, { recursive: true });
            
            // Move new app to app location
            renameSync(newAppBundlePath, runningAppBundlePath);
          } else {
            // On Windows, use versioned app folders
            const parentDir = dirname(runningAppBundlePath);
            const newVersionDir = join(parentDir, `app-${latestHash}`);
            
            // Create the versioned directory
            mkdirSync(newVersionDir, { recursive: true });
            
            // Copy all contents from the extracted app to the versioned directory
            const files = readdirSync(newAppBundlePath);
            for (const file of files) {
              const srcPath = join(newAppBundlePath, file);
              const destPath = join(newVersionDir, file);
              const stats = statSync(srcPath);
              
              if (stats.isDirectory()) {
                // Recursively copy directories
                cpSync(srcPath, destPath, { recursive: true });
              } else {
                // Copy files
                cpSync(srcPath, destPath);
              }
            }
            
            // Clean up the temporary extraction directory on Windows
            if (currentOS === 'win') {
              rmdirSync(extractionDir, { recursive: true });
            }
            
            // Create/update the launcher batch file
            const launcherPath = join(parentDir, "run.bat");
            const launcherContent = `@echo off
:: Electrobun App Launcher
:: This file launches the current version

:: Set current version
set CURRENT_HASH=${latestHash}
set APP_DIR=%~dp0app-%CURRENT_HASH%

:: TODO: Implement proper cleanup mechanism that checks for running processes
:: For now, old versions are kept to avoid race conditions during updates
:: :: Clean up old app versions (keep current and one backup)
:: for /d %%D in ("%~dp0app-*") do (
::     if not "%%~nxD"=="app-%CURRENT_HASH%" (
::         echo Removing old version: %%~nxD
::         rmdir /s /q "%%D" 2>nul
::     )
:: )

:: Launch the app
cd /d "%APP_DIR%\\bin"
start "" launcher.exe
`;
            
            await Bun.write(launcherPath, launcherContent);
            
            // Update desktop shortcuts to point to run.bat
            // This is handled by the running app, not the updater
            
            runningAppBundlePath = newVersionDir;
          }
        } catch (error) {
          console.error("Failed to replace app with new version", error);
          return;
        }

        // Cross-platform app launch
        switch (currentOS) {
          case 'macos':
            await Bun.spawn(["open", runningAppBundlePath]);
            break;
          case 'win':
            // On Windows, launch the run.bat file which handles versioning
            const parentDir = dirname(runningAppBundlePath);
            const runBatPath = join(parentDir, "run.bat");
            
            
            await Bun.spawn(["cmd", "/c", runBatPath], { detached: true });
            break;
          case 'linux':
            // On Linux, use shell backgrounding to detach the process
            const linuxLauncher = join(runningAppBundlePath, "bin", "launcher");
            Bun.spawn(["sh", "-c", `${linuxLauncher} &`], { detached: true});
            break;
        }
        // Use native killApp to properly clean up all resources on Linux
        // On other platforms, process.exit works fine
        if (currentOS === 'linux') {
          try {
            
            native.symbols.killApp();
            process.exit(0);
          } catch (e) {
            // Fallback if native binding fails
            process.exit(0);
          }
        } else {
          process.exit(0);
        }
      }
    }
  },

  channelBucketUrl: async () => {
    await Updater.getLocallocalInfo();
    const platformFolder = `${localInfo.channel}-${currentOS}-${currentArch}`;
    return join(localInfo.bucketUrl, platformFolder);
  },

  appDataFolder: async () => {
    await Updater.getLocallocalInfo();
    const appDataFolder = join(
      getAppDataDir(),
      localInfo.identifier,
      localInfo.name
    );

    return appDataFolder;
  },

  // TODO: consider moving this from "Updater.localInfo" to "BuildVars"
  localInfo: {
    version: async () => {
      return (await Updater.getLocallocalInfo()).version;
    },
    hash: async () => {
      return (await Updater.getLocallocalInfo()).hash;
    },
    channel: async () => {
      return (await Updater.getLocallocalInfo()).channel;
    },
    bucketUrl: async () => {
      return (await Updater.getLocallocalInfo()).bucketUrl;
    },
  },

  getLocallocalInfo: async () => {
    if (localInfo) {
      return localInfo;
    }

    try {
      const resourcesDir = 'Resources'; // Always use capitalized Resources
      localInfo = await Bun.file(`../${resourcesDir}/version.json`).json();
      return localInfo;
    } catch (error) {
      // Handle the error
      console.error("Failed to read version.json", error);

      // Then rethrow so the app crashes
      throw error;
    }
  },
};

export { Updater };
