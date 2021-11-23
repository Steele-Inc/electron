const { app, BrowserWindow } = require('electron')
// const aux_motor = require("./aux-motor")

function createWindow () {
  const win = new BrowserWindow({
    width: 1080 ,
    height: 1920,
//    width: 480 ,
//    height: 720,
//    kiosk:true,
//    fullscreen:true,
//    frame:false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      enableRemoteModule: true
    }
  })

  win.loadFile('rip-it.html')

  // Open DevTools - Remove for PRODUCTION!
  win.webContents.openDevTools();
  
}


app.whenReady().then(createWindow)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

console.log("Rip-It-Main started!")