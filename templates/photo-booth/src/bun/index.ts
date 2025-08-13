import Electrobun, { BrowserWindow, BrowserView, createRPC, Utils, type RPCSchema } from "electrobun/bun";

// Define RPC schema for photo saving
export type PhotoBoothRPC = {
  bun: RPCSchema<{
    requests: {
      savePhoto: {
        params: {
          dataUrl: string;
          filename: string;
        };
        response: {
          success: boolean;
          path?: string;
          reason?: string;
          error?: string;
        };
      };
    };
    messages: {};
  }>;
  webview: RPCSchema<{
    requests: {};
    messages: {};
  }>;
};

// Create RPC instance using BrowserView.defineRPC
const photoBoothRPC = BrowserView.defineRPC<PhotoBoothRPC>({
  maxRequestTime: 5000,
  handlers: {
    requests: {
      savePhoto: async ({ dataUrl, filename }) => {
        try {
          // Convert data URL to buffer
          const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, "");
          const buffer = Buffer.from(base64Data, "base64");
          
          // Show save dialog using Utils
          const chosenPaths = await Utils.openFileDialog({
            startingFolder: Bun.env.HOME || "/",
            allowedFileTypes: "png",
            canChooseFiles: false,
            canChooseDirectory: true,
            allowsMultipleSelection: false,
          });
          
          if (chosenPaths[0] && chosenPaths[0] !== "") {
            const savePath = `${chosenPaths[0]}/${filename}`;
            
            // Save the file
            await Bun.write(savePath, buffer);
            
            return { 
              success: true, 
              path: savePath 
            };
          } else {
            return { 
              success: false, 
              reason: "canceled" 
            };
          }
        } catch (error) {
          console.error("Error saving photo:", error);
          return { 
            success: false, 
            error: error.message 
          };
        }
      }
    },
    messages: {}
  }
});

// Create the main window
const mainWindow = new BrowserWindow({
  title: "Photo Booth",
  url: "views://mainview/index.html",
  renderer: "cef",
  frame: {
    width: 1000,
    height: 700,
    x: 100,
    y: 100,
  },
  rpc: photoBoothRPC,
});

console.log("Photo Booth app started!");