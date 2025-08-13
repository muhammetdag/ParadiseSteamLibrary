// Load environment variables from .env file
require('dotenv').config();

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const os = require('os');
const axios = require('axios');
const yauzl = require('yauzl');
const yauzlPromise = require('yauzl-promise');
const { spawn, exec } = require('child_process');
const tmp = require('os').tmpdir();
const { v4: uuidv4 } = require('uuid'); // Eğer uuid yoksa npm install uuid
const AdmZip = require('adm-zip');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);

const USER_ACTIVITY_API = "";
let userSessionId = null;
let isOnline = false;

class SteamLibraryManager {
  constructor() {
    this.mainWindow = null;
    this.appDataPath = path.join(os.homedir(), 'AppData', 'Local', 'paradisedev');
    this.configPath = path.join(this.appDataPath, 'config.json');
    this.gamesDataPath = path.join(this.appDataPath, 'games.json');
    this.onlineGamesCachePath = path.join(this.appDataPath, 'online_games.json');
    this.config = {};
    this.gamesCache = {};
    this.onlineGamesCache = { games: [], cached_at: 0 };
    this.lastApiCallAtByHost = {};
    this.discordRPC = null;

    this.init(); 
  }

  async openUrlInChrome(url) {
    // Daha güvenilir: where komutu ile bulmayı dene
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        exec('where chrome', (err, stdout, stderr) => {
          if (err) return reject(err);
          resolve({ stdout });
        });
      });
      const found = stdout.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (found.length > 0) {
        spawn(found[0], [url], { detached: true, stdio: 'ignore' });
        return true;
      }
    } catch (_) {}

    // Kandidat yolları sırayla dene
    for (const p of [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'Application', 'chrome.exe')
    ]) {
      try {
        if (await fs.pathExists(p)) {
          spawn(p, [url], { detached: true, stdio: 'ignore' });
          return true;
        }
      } catch (_) {}
    }

    // Olmazsa varsayılan tarayıcı
    await shell.openExternal(url);
    return true;
  }

  // Basit host-bazlı API cooldown bekletmesi
  async waitApiCooldown(hostname) {
    try {
      const now = Date.now();
      const lastAt = this.lastApiCallAtByHost[hostname] || 0;
      const cooldown = Math.max(0, (this.config.apiCooldown || 1000));
      const elapsed = now - lastAt;
      if (elapsed < cooldown) {
        await new Promise(res => setTimeout(res, cooldown - elapsed));
      }
      this.lastApiCallAtByHost[hostname] = Date.now();
    } catch (_) {
      // yok say
    }
  }

  // Online oyun listesi için önbellek + TTL
  async getOnlineGamesWithCache(ttlMs = 24 * 60 * 60 * 1000) {
    try {
      const now = Date.now();
      if (Array.isArray(this.onlineGamesCache.games) && this.onlineGamesCache.games.length > 0) {
        if (now - (this.onlineGamesCache.cached_at || 0) < ttlMs) {
          return this.onlineGamesCache.games;
        }
      }

      await this.waitApiCooldown('api.muhammetdag.com');
      const response = await axios.get('https://api.muhammetdag.com/steamlib/online/online_fix_games.json', {
        timeout: 15000,
        headers: {
          'User-Agent': `ParadiseSteamLibrary/${app.getVersion()}`
        }
      });

      const games = Array.isArray(response.data) ? response.data : [];
      this.onlineGamesCache = { games, cached_at: now };
      await this.saveOnlineGamesCache();
      return games;
    } catch (error) {
      console.error('Failed to fetch online games list, using cache if available:', error.message);
      return Array.isArray(this.onlineGamesCache.games) ? this.onlineGamesCache.games : [];
    }
  }

  async startUserSession() {
    try {
      userSessionId = uuidv4();
      const userData = {
        sessionId: userSessionId,
        appVersion: app.getVersion(),
        platform: process.platform,
        timestamp: new Date().toISOString(),
        action: 'start'
      };

      const response = await axios.post(USER_ACTIVITY_API, userData, {
        timeout: 5000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `ParadiseSteamLibrary/${app.getVersion()}`,
          'X-API-Key': ""
        }
      });

      if (response.status === 200) {
        isOnline = true;
        console.log('✓ Kullanıcı oturumu başlatıldı');
        
        if (this.mainWindow) {
          this.mainWindow.webContents.send('update-active-users', response.data.activeUsers);
        }
      }
    } catch (error) {
      console.log('✗ Kullanıcı oturumu başlatılamadı:', error.message);
    }
  }

  async endUserSession() {
    if (!userSessionId || !isOnline) return;

    try {
      const userData = {
        sessionId: userSessionId,
        timestamp: new Date().toISOString(),
        action: 'end'
      };

      await axios.post(USER_ACTIVITY_API, userData, {
        timeout: 3000,
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': `ParadiseSteamLibrary/${app.getVersion()}`,
          'X-API-Key': ""
        }
      });

      console.log('✓ Kullanıcı oturumu sonlandırıldı');
    } catch (error) {
      console.log('✗ Kullanıcı oturumu sonlandırılamadı:', error.message);
    }
  }

  async getActiveUsersCount() {
    try {
      const response = await axios.get(`${USER_ACTIVITY_API}/count`, {
        timeout: 5000,
        headers: {
          'User-Agent': `ParadiseSteamLibrary/${app.getVersion()}`,
          'X-API-Key': ""
        }
      });

      return response.data.activeUsers;
    } catch (error) {
      console.log('✗ Aktif kullanıcı sayısı alınamadı:', error.message);
      return 0;
    }
  }

  async checkExternalTools() {
    console.log('Checking external tools availability...');
    
    // 7-Zip kontrolü
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);
      
      await execAsync('7z --version');
      console.log('✓ 7-Zip is available');
    } catch (error) {
      console.log('✗ 7-Zip is not available:', error.message);
    }
    
    // WinRAR kontrolü
    const winrarPaths = [
      'C:\\Program Files\\WinRAR\\WinRAR.exe',
      'C:\\Program Files (x86)\\WinRAR\\WinRAR.exe'
    ];
    
    for (const winrarPath of winrarPaths) {
      try {
        const fs = require('fs-extra');
        await fs.access(winrarPath);
        console.log(`✓ WinRAR found at: ${winrarPath}`);
      } catch (error) {
        console.log(`✗ WinRAR not found at: ${winrarPath}`);
      }
    }
    
    // Sistem PATH'den WinRAR kontrolü
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);
      
      await execAsync('winrar --version');
      console.log('✓ WinRAR is available in system PATH');
    } catch (error) {
      console.log('✗ WinRAR is not available in system PATH:', error.message);
    }
  }

  async init() {
    await this.ensureAppDataDir();
    await this.loadConfig();
    await this.loadGamesCache();
    await this.loadOnlineGamesCache();
    await this.initDiscordRPC();
    await this.checkExternalTools(); // Harici araçları kontrol et
  }

  async ensureAppDataDir() {
    await fs.ensureDir(this.appDataPath);
  }

  async loadConfig() {
    try {
      if (await fs.pathExists(this.configPath)) {
        this.config = await fs.readJson(this.configPath);
      } else {
        this.config = {
          steamPath: '',
          theme: 'dark',
          autoStart: false,
          discordRPC: true,
          animations: true,
          soundEffects: true,
          apiCooldown: 1000,
          maxConcurrentRequests: 5,
          discordInviteAsked: false
        };
        await this.saveConfig();
      }
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  }

  async saveConfig() {
    try {
      await fs.writeJson(this.configPath, this.config, { spaces: 2 });
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  }

  async loadGamesCache() {
    try {
      if (await fs.pathExists(this.gamesDataPath)) {
        this.gamesCache = await fs.readJson(this.gamesDataPath);
      } else {
        this.gamesCache = {};
      }
    } catch (error) {
      console.error('Failed to load games cache:', error);
    }
  }

  async saveGamesCache() {
    try {
      await fs.writeJson(this.gamesDataPath, this.gamesCache, { spaces: 2 });
    } catch (error) {
      console.error('Failed to save games cache:', error);
    }
  }

  async loadOnlineGamesCache() {
    try {
      if (await fs.pathExists(this.onlineGamesCachePath)) {
        const data = await fs.readJson(this.onlineGamesCachePath);
        this.onlineGamesCache = {
          games: Array.isArray(data?.games) ? data.games : [],
          cached_at: typeof data?.cached_at === 'number' ? data.cached_at : 0
        };
      } else {
        this.onlineGamesCache = { games: [], cached_at: 0 };
      }
    } catch (error) {
      console.error('Failed to load online games cache:', error);
      this.onlineGamesCache = { games: [], cached_at: 0 };
    }
  }

  async saveOnlineGamesCache() {
    try {
      await fs.writeJson(this.onlineGamesCachePath, this.onlineGamesCache, { spaces: 2 });
    } catch (error) {
      console.error('Failed to save online games cache:', error);
    }
  }

  async initDiscordRPC() {
    if (!this.config.discordRPC) return;
    
    try {
      const DiscordRPC = require('discord-rpc');
      const clientId = '1396248989413806140'; 
      
      this.discordRPC = new DiscordRPC.Client({ transport: 'ipc' });
      
      this.discordRPC.on('ready', () => {
        this.updateDiscordActivity('Browsing Steam Library', 'In Paradise Hub');
      });
      
      await this.discordRPC.login({ clientId });
    } catch (error) {
      console.error('Failed to initialize Discord RPC:', error);
    }
  }

  updateDiscordActivity(details, state) {
    if (!this.discordRPC) return;
    
    try {
      this.discordRPC.setActivity({
        details,
        state,
        startTimestamp: Date.now(),
        largeImageKey: 'paradise-logo',
        largeImageText: 'Paradise Steam Library',
        smallImageKey: 'steam-logo',
        smallImageText: 'Steam',
        buttons: [
          {
            label: 'Discord',
            url: 'https://discord.gg/YNXenatwUT'
          }
        ],
        instance: false,
      });
    } catch (error) {
      console.error('Failed to update Discord activity:', error);
    }
  }

  async createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1200,
      minHeight: 700,
      frame: false,
      titleBarStyle: 'hidden',
      title: 'Paradise Steam Library',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false,
     
      },
      show: false,
      backgroundColor: '#0a0a0a',
      icon: path.join(__dirname, 'icons', 'icon.ico') 
    });

    this.mainWindow.loadFile('src/renderer/index.html');

    this.mainWindow.once('ready-to-show', () => {
      this.mainWindow.show();
      
      if (process.argv.includes('--dev')) {
        this.mainWindow.webContents.openDevTools();
      }
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    // Global referansı ayarla
    global.steamManager = this;

    this.setupIPC();
  }

  setupIPC() {
    // Window controls
    ipcMain.handle('window-minimize', () => {
      this.mainWindow.minimize();
    });

    ipcMain.handle('window-maximize', () => {
      if (this.mainWindow.isMaximized()) {
        this.mainWindow.unmaximize();
      } else {
        this.mainWindow.maximize();
      }
    });

    ipcMain.handle('window-close', () => {
      this.mainWindow.close();
    });

    // Configuration
    ipcMain.handle('get-config', () => {
      return this.config;
    });

    ipcMain.handle('save-config', async (event, newConfig) => {
      this.config = { ...this.config, ...newConfig };
      await this.saveConfig();
      return this.config;
    });

    // Steam path selection
    ipcMain.handle('select-steam-path', async () => {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        properties: ['openDirectory'],
        title: 'Steam Klasörünü Seçin'
      });

      if (!result.canceled && result.filePaths.length > 0) {
        const steamPath = result.filePaths[0];
        const steamExe = path.join(steamPath, 'steam.exe');
        
        if (await fs.pathExists(steamExe)) {
          this.config.steamPath = steamPath;
          await this.saveConfig();
          await this.ensureSteamDirectories();
          return steamPath;
        } else {
          throw new Error('steam.exe seçilen klasörde bulunamadı');
        }
      }
      return null;
    });

    // URL'i Google Chrome'da aç
    ipcMain.handle('open-in-chrome', async (event, url) => {
      try {
        return await this.openUrlInChrome(url);
      } catch (error) {
        console.error('Failed to open in Chrome:', error);
        // Son çare: varsayılan tarayıcıda aç
        try { await shell.openExternal(url); } catch {}
        return false;
      }
    });

    // Uygulama sürümünü döndür
    ipcMain.handle('get-app-version', () => {
      try {
        return app.getVersion();
      } catch (e) {
        return null;
      }
    });

    // Steam API operations
    ipcMain.handle('fetch-steam-games', async (event, category = 'featured', page = 1) => {
      return await this.fetchSteamGames(category, page);
    });

    ipcMain.handle('fetch-game-details', async (event, appId) => {
      return await this.fetchGameDetails(appId);
    });

    ipcMain.handle('search-games', async (event, query) => {
      return await this.searchGames(query);
    });

    ipcMain.handle('add-game-to-library', async (event, appId, includeDLCs = []) => {
      return await this.addGameToLibrary(appId, includeDLCs);
    });

    ipcMain.handle('get-library-games', async () => {
      return await this.getLibraryGames();
    });

    ipcMain.handle('restart-steam', async () => {
      return await this.restartSteam();
    });

    ipcMain.handle('delete-game', async (event, appId) => {
      return await this.deleteGameFromLibrary(appId);
    });

    // External links
    ipcMain.handle('open-external', async (event, url) => {
      shell.openExternal(url);
    });

    // Klasör seçme
    ipcMain.handle('select-directory', async (event, title) => {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        properties: ['openDirectory'],
        title: title || 'Klasör Seçin'
      });
      return result;
    });

    // Manuel oyun kurulumu
    ipcMain.handle('install-manual-game', async (event, gameData) => {
      try {
        if (!this.config.steamPath) {
          throw new Error('Steam path not configured');
        }

        const { file } = gameData;
        
        // Dosya varlığını kontrol et
        if (!await fs.pathExists(file)) {
          throw new Error('Seçilen dosya bulunamadı');
        }

        // Dosya boyutunu kontrol et
        const stats = await fs.stat(file);
        if (stats.size < 1000) {
          throw new Error('Dosya çok küçük veya bozuk');
        }

        // Dosya türünü kontrol et
        const buffer = await fs.readFile(file);
        const isZip = buffer.slice(0, 4).toString('hex') === '504b0304';
        
        if (!isZip) {
          throw new Error('Geçersiz ZIP dosyası');
        }

        // ZIP dosyasını ayıkla ve oyun bilgilerini çek
        const gameInfo = await this.extractManualGameFiles(file);
        
        return { success: true, message: 'Oyun başarıyla kuruldu', gameInfo };
      } catch (error) {
        console.error('Failed to install manual game:', error);
        throw error;
      }
    });

    // Test ZIP extraction - Debugging için
    ipcMain.handle('test-zip-extraction', async (event, zipPath, targetDir) => {
      try {
        console.log('=== TESTING ZIP EXTRACTION ===');
        console.log('ZIP Path:', zipPath);
        console.log('Target Directory:', targetDir);
        
        // Dosya varlığını kontrol et
        if (!await fs.pathExists(zipPath)) {
          throw new Error(`ZIP dosyası bulunamadı: ${zipPath}`);
        }
        
        const stats = await fs.stat(zipPath);
        console.log('ZIP file size:', stats.size, 'bytes');
        
        // Hedef klasörü oluştur
        await fs.ensureDir(targetDir);
        console.log('Target directory created/verified');
        
        // Extraction test et
        await this.extractZipFile(zipPath, targetDir);
        
        console.log('=== ZIP EXTRACTION TEST SUCCESSFUL ===');
        return { success: true, message: 'ZIP extraction test successful' };
      } catch (error) {
        console.log('=== ZIP EXTRACTION TEST FAILED ===');
        console.log('Error:', error.message);
        return { success: false, error: error.message };
      }
    });

    // Aktif kullanıcı sayısı için IPC handler'ları
    ipcMain.handle('get-active-users-count', async () => {
      return await this.getActiveUsersCount();
    });

    ipcMain.handle('refresh-active-users', async () => {
      const count = await this.getActiveUsersCount();
      if (this.mainWindow) {
        this.mainWindow.webContents.send('update-active-users', count);
      }
      return count;
    });

    // Online oyun dosyası indirme
    ipcMain.handle('download-online-file', async (event, appId) => {
      try {
        console.log('Downloading online file for appId:', appId);
        
        // Önce oyun listesini (TTL + cache ile) al
        const games = await this.getOnlineGamesWithCache();
        
        const game = games.find(g => g.appid === parseInt(appId));
        
        if (!game) {
          console.error('Game not found in list. Available appIds:', games.map(g => g.appid));
          throw new Error('Oyun bulunamadı');
        }
        
        // Klasör seçtir
        const { canceled, filePaths } = await dialog.showOpenDialog({
          title: 'Oyun Klasörünü Seçin',
          properties: ['openDirectory', 'createDirectory']
        });
        if (canceled || !filePaths || !filePaths[0]) return;

        const targetDir = filePaths[0];

        // Dosya indirme işlemi
        const tempZipPath = path.join(tmp, `${appId}_${uuidv4()}.zip`);
        
        try {
          // Basit rate limit: aynı host için config.apiCooldown'a uy
          await this.waitApiCooldown('api.muhammetdag.com');
          // Dosyayı temp'e indir
          const downloadResponse = await axios.get(`https://api.muhammetdag.com/steamlib/online/index.php?appid=${appId}`, {
            responseType: 'stream',
            timeout: 120000,
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/zip,application/octet-stream,*/*',
              'Accept-Encoding': 'gzip, deflate',
              'Connection': 'keep-alive'
            }
          });

          await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(tempZipPath);
            downloadResponse.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
          });

          // Dosya boyutunu kontrol et
          const stats = await fs.stat(tempZipPath);
          if (stats.size < 1000) {
            throw new Error('İndirilen dosya çok küçük veya erişilemiyor');
          }

          // Dosya türünü kontrol et
          const buffer = await fs.readFile(tempZipPath);
          const isZip = buffer.slice(0, 4).toString('hex') === '504b0304';
          
          if (!isZip) {
            // ZIP değilse, dosyayı doğrudan kopyala
            const targetFile = path.join(targetDir, `${game.name.replace(/[^a-zA-Z0-9]/g, '_')}.zip`);
            await fs.copy(tempZipPath, targetFile);
            await fs.remove(tempZipPath);
            return true;
          }

          // ZIP dosyasını ayıkla
          try {
            await this.extractZipFile(tempZipPath, targetDir);
          } catch (zipError) {
            console.log('ZIP ayıklama başarısız, dosyayı doğrudan kopyalıyor:', zipError.message);
            // ZIP ayıklama başarısız olursa, dosyayı doğrudan kopyala
            const targetFile = path.join(targetDir, `${game.name.replace(/[^a-zA-Z0-9]/g, '_')}.zip`);
            await fs.copy(tempZipPath, targetFile);
          }

          // Temp dosyasını sil
          try {
            await fs.remove(tempZipPath);
          } catch (removeError) {
            console.log('Temp dosyası silinemedi:', removeError.message);
          }

        } catch (err) {
          try { await fs.remove(tempZipPath); } catch {}
          console.error('Download error details:', {
            appId,
            url: `https://api.muhammetdag.com/steamlib/online/index.php?appid=${appId}`,
            error: err.message,
            status: err.response?.status,
            statusText: err.response?.statusText,
            data: err.response?.data
          });
          throw new Error(`Dosya indirme hatası: ${err.message}`);
        }

        return true;
      } catch (err) {
        throw err;
      }
    });

    // YENİ SİSTEM - YORUM SATIRINA ALINDI
    // ipcMain.handle('download-online-file', async (event, appId) => {
    //   try {
    //     console.log('Downloading online file for appId:', appId);
    //     
    //     // Önce oyun bilgilerini al
    //     const gamesResponse = await axios.get('https://api.muhammetdag.com/steamlib/online/online_fix_games.json');
    //     const games = gamesResponse.data;
    //     //console.log('Available games:', games);
    //     
    //     const game = games.find(g => g.appid === parseInt(appId));
    //     
    //     if (!game) {
    //       console.error('Game not found in list. Available appIds:', games.map(g => g.appid));
    //       throw new Error('Oyun bulunamadı');
    //     }
    //     
    //     //console.log('Found game:', game);

    //     // Klasör seçtir
    //     const { canceled, filePaths } = await dialog.showOpenDialog({
    //       title: 'Oyun Klasörünü Seçin',
    //       properties: ['openDirectory', 'createDirectory']
    //     });
    //     if (canceled || !filePaths || !filePaths[0]) return;

    //     const targetDir = filePaths[0];

    //     // Dosya indirme işlemi
    //     const tempZipPath = path.join(tmp, `${appId}_${uuidv4()}.zip`);
    //     
    //     try {
    //       // Dosyayı temp'e indir
    //       const downloadResponse = await axios.get(`https://api.muhammetdag.com/steamlib/online/index.php?appid=${appId}`, {
    //         responseType: 'stream',
    //         timeout: 120000,
    //         headers: {
    //           'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    //           'Accept': 'application/zip,application/octet-stream,*/*',
    //           'Accept-Encoding': 'gzip, deflate',
    //           'Connection': 'keep-alive'
    //         }
    //       });

    //       await new Promise((resolve, reject) => {
    //         const writer = fs.createWriteStream(tempZipPath);
    //         downloadResponse.data.pipe(writer);
    //         writer.on('finish', resolve);
    //         writer.on('error', reject);
    //       });

    //       // Dosya boyutunu kontrol et
    //       const stats = await fs.stat(tempZipPath);
    //       if (stats.size < 1000) {
    //         throw new Error('İndirilen dosya çok küçük veya erişilemiyor');
    //       }

    //       // Dosya türünü kontrol et
    //       const buffer = await fs.readFile(tempZipPath);
    //       const isZip = buffer.slice(0, 4).toString('hex') === '504b0304';
    //       
    //       if (!isZip) {
    //         // ZIP değilse, dosyayı doğrudan kopyala
    //         const targetFile = path.join(targetDir, `${game.name.replace(/[^a-zA-Z0-9]/g, '_')}.zip`);
    //         await fs.copy(tempZipPath, targetFile);
    //         await fs.remove(tempZipPath);
    //         return true;
    //       }

    //       // ZIP dosyasını ayıkla
    //       try {
    //         await this.extractZipFile(tempZipPath, targetDir);
    //       } catch (zipError) {
    //         console.log('ZIP ayıklama başarısız, dosyayı doğrudan kopyalıyor:', zipError.message);
    //         // ZIP ayıklama başarısız olursa, dosyayı doğrudan kopyala
    //         const targetFile = path.join(targetDir, `${game.name.replace(/[^a-zA-Z0-9]/g, '_')}.zip`);
    //         await fs.copy(tempZipPath, targetFile);
    //       }

    //       // Temp dosyasını sil
    //       try {
    //         await fs.remove(tempZipPath);
    //       } catch (removeError) {
    //         console.log('Temp dosyası silinemedi:', removeError.message);
    //       }

    //     } catch (err) {
    //       try { await fs.remove(tempZipPath); } catch {}
    //       console.error('Download error details:', {
    //         appId,
    //         url: `https://api.muhammetdag.com/steamlib/online/index.php?appid=${appId}`,
    //         error: err.message,
    //         status: err.response?.status,
    //         statusText: err.response?.statusText,
    //         data: err.response?.data
    //       });
    //       throw new Error(`Dosya indirme hatası: ${err.message}`);
    //     }

    //     return true;
    //   } catch (err) {
    //     throw err;
    //   }
    // });
  }

  async ensureSteamDirectories() {
    if (!this.config.steamPath) return;

    const configDir = path.join(this.config.steamPath, 'config');
    const stpluginDir = path.join(configDir, 'stplug-in');
    const depotcacheDir = path.join(configDir, 'depotcache');

    await fs.ensureDir(stpluginDir);
    await fs.ensureDir(depotcacheDir);
  }

  async fetchSteamGames(category = 'featured', page = 1) {
    try {
      let games = [];
      
      switch (category) {
        case 'featured':
          await this.waitApiCooldown('store.steampowered.com');
          games = await this.fetchFeaturedGames();
          break;
        case 'popular':
          await this.waitApiCooldown('store.steampowered.com');
          games = await this.fetchPopularGames();
          break;
        case 'new':
          await this.waitApiCooldown('store.steampowered.com');
          games = await this.fetchNewReleases();
          break;
        case 'top':
          await this.waitApiCooldown('store.steampowered.com');
          games = await this.fetchTopRated();
          break;
        case 'free':
          await this.waitApiCooldown('store.steampowered.com');
          games = await this.fetchFreeGames();
          break;
        case 'action':
          await this.waitApiCooldown('store.steampowered.com');
          games = await this.fetchGamesByGenre('Action');
          break;
        case 'rpg':
          await this.waitApiCooldown('store.steampowered.com');
          games = await this.fetchGamesByGenre('RPG');
          break;
        case 'strategy':
          await this.waitApiCooldown('store.steampowered.com');
          games = await this.fetchGamesByGenre('Strategy');
          break;
        default:
          await this.waitApiCooldown('store.steampowered.com');
          games = await this.fetchFeaturedGames();
      }

      // Cache the games
      for (const game of games) {
        this.gamesCache[game.appid] = {
          ...game,
          cached_at: Date.now()
        };
      }
      
      await this.saveGamesCache();
      return games;
    } catch (error) {
      console.error('Failed to fetch Steam games:', error);
      return [];
    }
  }

  async fetchFeaturedGames() {
    await this.waitApiCooldown('store.steampowered.com');
    const response = await axios.get('https://store.steampowered.com/api/featured/', {
      timeout: 10000
    });
    
    if (response.data.featured_win) {
      return response.data.featured_win.map(game => this.processGameData(game));
    }
    return [];
  }

  async fetchPopularGames() {
    await this.waitApiCooldown('store.steampowered.com');
    const response = await axios.get('https://store.steampowered.com/api/featuredcategories/', {
      timeout: 10000
    });
    
    if (response.data.top_sellers?.items) {
      return response.data.top_sellers.items.map(game => this.processGameData(game));
    }
    return [];
  }

  async fetchNewReleases() {
    await this.waitApiCooldown('store.steampowered.com');
    const response = await axios.get('https://store.steampowered.com/api/featuredcategories/', {
      timeout: 10000
    });
    
    if (response.data.new_releases?.items) {
      return response.data.new_releases.items.map(game => this.processGameData(game));
    }
    return [];
  }

  async fetchTopRated() {
    // Fetch top rated games from Steam API
    await this.waitApiCooldown('store.steampowered.com');
    const response = await axios.get('https://store.steampowered.com/api/featuredcategories/', {
      timeout: 10000
    });
    
    if (response.data.specials?.items) {
      return response.data.specials.items.map(game => this.processGameData(game));
    }
    return [];
  }

  async fetchFreeGames() {
    await this.waitApiCooldown('store.steampowered.com');
    const response = await axios.get('https://store.steampowered.com/api/featuredcategories/', {
      timeout: 10000
    });
    
    if (response.data.featured_win) {
      return response.data.featured_win
        .filter(game => !game.final_price || game.final_price === 0)
        .map(game => this.processGameData(game));
    }
    return [];
  }

  async fetchGamesByGenre(genre) {
    // This would typically require Steam Spy API or similar
    // For now, return filtered featured games
    await this.waitApiCooldown('store.steampowered.com');
    const featuredGames = await this.fetchFeaturedGames();
    return featuredGames.filter(game => 
      game.tags?.some(tag => tag.name.toLowerCase().includes(genre.toLowerCase()))
    );
  }

  processGameData(game) {
    const isDLC = Array.isArray(game.categories) && game.categories.some(cat => cat.id === 21);
    const processedGame = {
      appid: game.id,
      name: game.name,
      header_image: game.header_image,
      price: game.final_price || 0,
      discount_percent: game.discount_percent || 0,
      platforms: game.platforms || {},
      coming_soon: game.coming_soon || false,
      tags: this.generateGameTags(game),
      short_description: game.short_description || '',
      reviews: game.reviews || 'Mixed',
      is_dlc: isDLC
    };

    return processedGame;
  }

  generateGameTags(game) {
    const tags = [];
    
    if (game.final_price === 0) {
      tags.push({ name: 'Ücretsiz', color: '#4CAF50' });
    }
    
    if (game.discount_percent > 0) {
      tags.push({ name: `${game.discount_percent}% İndirim`, color: '#FF6B6B' });
    }
    
    if (game.coming_soon) {
      tags.push({ name: 'Yakında', color: '#9C27B0' });
    }

    // Add Denuvo tag if detected
    if (game.name && this.isDenuvoProbable(game.name)) {
      tags.push({ name: 'Denuvo', color: '#FF9800' });
    }

    // Add EA tag if it's an EA game
    if (game.name && this.isEAGame(game.name)) {
      tags.push({ name: 'EA', color: '#FF5722' });
    }

    // Add online multiplayer tag
    if (this.isOnlineGame(game)) {
      tags.push({ name: 'Online', color: '#2196F3' });
    }

    return tags;
  }

  isDenuvoProbable(gameName) {
    // List of games known to use Denuvo
    const denuvoProbableGames = [
      'resident evil', 'assassin\'s creed', 'far cry', 'watch dogs',
      'deus ex', 'rise of the tomb raider', 'doom', 'battlefield',
      'star wars', 'dragon age', 'mass effect', 'need for speed'
    ];
    
    return denuvoProbableGames.some(game => 
      gameName.toLowerCase().includes(game)
    );
  }

  isEAGame(gameName) {
    const eaGames = [
      'fifa', 'battlefield', 'apex legends', 'titanfall', 'mass effect',
      'dragon age', 'the sims', 'need for speed', 'plants vs zombies',
      'dead space', 'crysis', 'mirror\'s edge'
    ];
    
    return eaGames.some(game => 
      gameName.toLowerCase().includes(game)
    );
  }

  isOnlineGame(game) {
    const onlineKeywords = [
      'multiplayer', 'online', 'mmo', 'battle royale', 'co-op',
      'pvp', 'competitive', 'esports'
    ];
    
    return onlineKeywords.some(keyword => 
      game.name?.toLowerCase().includes(keyword) ||
      game.short_description?.toLowerCase().includes(keyword)
    );
  }

  async searchGames(query) {
    try {
      // Search in cached games first
      const cachedResults = Object.values(this.gamesCache).filter(game =>
        game.name.toLowerCase().includes(query.toLowerCase())
      );

      if (cachedResults.length > 0) {
        return cachedResults;
      }

      // If no cached results, search Steam API (cooldown uygula)
      await this.waitApiCooldown('store.steampowered.com');
      const response = await axios.get(`https://store.steampowered.com/api/storeSearch/?term=${encodeURIComponent(query)}&l=english&cc=US`, {
        timeout: 10000
      });

      if (response.data.items) {
        return response.data.items.map(item => this.processGameData(item));
      }

      return [];
    } catch (error) {
      console.error('Failed to search games:', error);
      return [];
    }
  }

  async fetchGameDetails(appId) {
    try {
      // Check cache first
      const cached = this.gamesCache[appId];
      if (cached && cached.detailed && (Date.now() - cached.cached_at) < 3600000) {
        return cached;
      }

      await this.waitApiCooldown('store.steampowered.com');
      const response = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}`, {
        timeout: 10000
      });

      const gameData = response.data[appId];
      if (!gameData || !gameData.success) {
        throw new Error('Game not found');
      }

      const details = gameData.data;
      const gameDetails = {
        appid: appId,
        name: details.name,
        header_image: details.header_image,
        screenshots: details.screenshots || [],
        movies: details.movies || [],
        description: details.short_description,
        detailed_description: details.detailed_description,
        developers: details.developers || [],
        publishers: details.publishers || [],
        genres: details.genres || [],
        categories: details.categories || [],
        release_date: details.release_date,
        price: details.price_overview || { final: 0, currency: 'USD' },
        dlc: details.dlc || [],
        platforms: details.platforms || {},
        metacritic: details.metacritic || null,
        tags: this.generateGameTags(details),
        detailed: true,
        cached_at: Date.now()
      };

      this.gamesCache[appId] = gameDetails;
      await this.saveGamesCache();

      return gameDetails;
    } catch (error) {
      console.error(`Failed to fetch game details for ${appId}:`, error);
      return null;
    }
  }

  async addGameToLibrary(appId, includeDLCs = []) {
    try {
      if (!this.config.steamPath) {
        throw new Error('Steam path not configured');
      }

      // Download game files
      const gameUrl = `https://api.muhammetdag.com/steamlib/game/game.php?steamid=${appId}`;
      const response = await axios.get(gameUrl, { 
        responseType: 'stream',
        timeout: 30000
      });
      
      const tempZipPath = path.join(this.appDataPath, `${appId}.zip`);
      const writer = fs.createWriteStream(tempZipPath);
      
      response.data.pipe(writer);
      
      return new Promise((resolve, reject) => {
        writer.on('finish', async () => {
          try {
            await this.extractGameFiles(tempZipPath, appId);
            
            // Add DLCs if selected
            if (includeDLCs.length > 0) {
              await this.addDLCsToGame(appId, includeDLCs);
            }
            
            // Clean up
            await fs.remove(tempZipPath);
            
            resolve({ success: true, message: 'Game added successfully' });
          } catch (error) {
            reject(error);
          }
        });
        
        writer.on('error', reject);
      });
    } catch (error) {
      console.error('Failed to add game to library:', error);
      throw error;
    }
  }

  async extractGameFiles(zipPath, appId) {
    const stpluginDir = path.join(this.config.steamPath, 'config', 'stplug-in');
    const depotcacheDir = path.join(this.config.steamPath, 'config', 'depotcache');
    
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        
        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          if (/\/$/.test(entry.fileName)) {
            zipfile.readEntry();
          } else {
            zipfile.openReadStream(entry, (err, readStream) => {
              if (err) return reject(err);
              
              let targetPath;
              if (entry.fileName.endsWith('.lua')) {
                targetPath = path.join(stpluginDir, path.basename(entry.fileName));
              } else if (entry.fileName.endsWith('.manifest')) {
                targetPath = path.join(depotcacheDir, path.basename(entry.fileName));
              } else {
                zipfile.readEntry();
                return;
              }
              
              const writeStream = fs.createWriteStream(targetPath);
              readStream.pipe(writeStream);
              
              writeStream.on('close', () => {
                zipfile.readEntry();
              });
            });
          }
        });
        
        zipfile.on('end', () => {
          resolve();
        });
        
        zipfile.on('error', reject);
      });
    });
  }

  async addDLCsToGame(appId, dlcIds) {
    const marcellusPath = path.join(this.config.steamPath, 'config', 'stplug-in', 'marcellus.lua');
    
    let existingContent = '';
    if (await fs.pathExists(marcellusPath)) {
      existingContent = await fs.readFile(marcellusPath, 'utf8');
    }
    
    const newLines = dlcIds
      .filter(dlcId => !existingContent.includes(`addappid(${dlcId}, 1)`))
      .map(dlcId => `addappid(${dlcId}, 1)`);
    
    if (newLines.length > 0) {
      await fs.appendFile(marcellusPath, '\n' + newLines.join('\n') + '\n');
    }
  }

  async getLibraryGames() {
    try {
      if (!this.config.steamPath) return [];
      
      const stpluginDir = path.join(this.config.steamPath, 'config', 'stplug-in');
      
      if (!await fs.pathExists(stpluginDir)) return [];
      
      const files = await fs.readdir(stpluginDir);
      const luaFiles = files.filter(file => file.endsWith('.lua') && file !== 'marcellus.lua');
      
      const gameIds = luaFiles.map(file => path.basename(file, '.lua')).filter(id => /^\d+$/.test(id));
      
      const games = [];
      for (const gameId of gameIds) {
        const gameDetails = await this.fetchGameDetails(gameId);
        if (gameDetails) {
          games.push(gameDetails);
        }
      }
      
      return games;
    } catch (error) {
      console.error('Failed to get library games:', error);
      return [];
    }
  }

  async restartSteam() {
    try {
      if (!this.config.steamPath) {
        throw new Error('Steam path not configured');
      }

      const steamExe = path.join(this.config.steamPath, 'steam.exe');
      
      // Kill Steam process
      exec('taskkill /F /IM steam.exe', (error) => {
        if (error) {
          console.log('Steam was not running or failed to close');
        }
        
        // Wait a bit then start Steam
        setTimeout(() => {
          spawn(steamExe, [], { detached: true, stdio: 'ignore' });
        }, 2000);
      });

      return { success: true, message: 'Steam is being restarted' };
    } catch (error) {
      console.error('Failed to restart Steam:', error);
      throw error;
    }
  }

  async deleteGameFromLibrary(appId) {
    if (!this.config.steamPath) {
      throw new Error('Steam path not configured');
    }
    const stpluginDir = path.join(this.config.steamPath, 'config', 'stplug-in');
    const luaPath = path.join(stpluginDir, `${appId}.lua`);
    try {
      if (await fs.pathExists(luaPath)) {
        await fs.remove(luaPath);
      }
      // Kütüphaneyi güncellemek için oyun listesini döndür
      return { success: true };
    } catch (error) {
      console.error('Failed to delete game:', error);
      return { success: false, error: error.message };
    }
  }

  async getFileSize(url) {
    try {
      const response = await axios.head(url, {
        timeout: 10000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      return parseInt(response.headers['content-length'] || '0');
    } catch (error) {
      console.error('Failed to get file size:', error);
      return 0;
    }
  }



  async extractManualGameFiles(zipPath) {
    const stpluginDir = path.join(this.config.steamPath, 'config', 'stplug-in');
    const depotcacheDir = path.join(this.config.steamPath, 'config', 'depotcache');
    
    // Klasörleri oluştur
    await fs.ensureDir(stpluginDir);
    await fs.ensureDir(depotcacheDir);
    
    let appId = null;
    let gameName = 'Bilinmeyen Oyun';
    
    return new Promise((resolve, reject) => {
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) return reject(err);
        
        zipfile.readEntry();
        zipfile.on('entry', (entry) => {
          if (/\/$/.test(entry.fileName)) {
            zipfile.readEntry();
          } else {
            zipfile.openReadStream(entry, (err, readStream) => {
              if (err) return reject(err);
              
              let targetPath;
              if (entry.fileName.endsWith('.lua')) {
                targetPath = path.join(stpluginDir, path.basename(entry.fileName));
                // App ID'yi çıkar
                const fileName = path.basename(entry.fileName, '.lua');
                if (/^\d+$/.test(fileName)) {
                  appId = fileName;
                }
              } else if (entry.fileName.endsWith('.manifest')) {
                targetPath = path.join(depotcacheDir, path.basename(entry.fileName));
              } else {
                zipfile.readEntry();
                return;
              }
              
              const writeStream = fs.createWriteStream(targetPath);
              readStream.pipe(writeStream);
              
              writeStream.on('close', () => {
                zipfile.readEntry();
              });
            });
          }
        });
        
        zipfile.on('end', async () => {
          // App ID'den oyun adını çek
          if (appId) {
            try {
              const gameDetails = await this.fetchGameDetails(appId);
              if (gameDetails && gameDetails.name) {
                gameName = gameDetails.name;
              }
            } catch (error) {
              console.log('Could not fetch game details for ID:', appId);
            }
          }
          
          resolve({
            appId: appId,
            name: gameName
          });
        });
        
        zipfile.on('error', reject);
      });
    });
  }



  async extractZipFile(zipPath, targetDir) {
    return new Promise((resolve, reject) => {
      console.log('Extracting ZIP archive:', zipPath);
      console.log('Target directory:', targetDir);
      
      try {
        // Hedef klasörü oluştur
        fs.ensureDir(targetDir).then(() => {
          console.log('Target directory created/verified:', targetDir);
          
          // 7-Zip ile ayıklama (şifresiz)
          const command = `7z x "${zipPath}" -o"${targetDir}" -y`;
          console.log('Trying 7-Zip command:', command);
          
          exec(command, (error, stdout, stderr) => {
            if (error) {
              console.log('7-Zip failed with error:', error.message);
              console.log('7-Zip stderr:', stderr);
              console.log('7-Zip stdout:', stdout);
              console.log('Trying WinRAR...');
              
              // WinRAR ile dene (şifresiz) - düzeltilmiş komut
              const winrarCommand = `"C:\\Program Files\\WinRAR\\WinRAR.exe" x -y "${zipPath}" "${targetDir}\\"`;
              console.log('Trying WinRAR command:', winrarCommand);
              
              exec(winrarCommand, (wrError, wrStdout, wrStderr) => {
                if (wrError) {
                  console.log('WinRAR failed with error:', wrError.message);
                  console.log('WinRAR stderr:', wrStderr);
                  console.log('WinRAR stdout:', wrStdout);
                  console.log('Trying alternative WinRAR path...');
                  
                  // Alternatif WinRAR yolu dene
                  const winrarAltCommand = `"C:\\Program Files (x86)\\WinRAR\\WinRAR.exe" x -y "${zipPath}" "${targetDir}\\"`;
                  console.log('Trying WinRAR (x86) command:', winrarAltCommand);
                  
                  exec(winrarAltCommand, (wrAltError, wrAltStdout, wrAltStderr) => {
                    if (wrAltError) {
                      console.log('WinRAR (x86) failed with error:', wrAltError.message);
                      console.log('WinRAR (x86) stderr:', wrAltStderr);
                      console.log('WinRAR (x86) stdout:', wrAltStdout);
                      console.log('Trying system PATH WinRAR...');
                      
                      // Sistem PATH'den WinRAR dene
                      const winrarPathCommand = `winrar x -y "${zipPath}" "${targetDir}\\"`;
                      console.log('Trying WinRAR (PATH) command:', winrarPathCommand);
                      
                      exec(winrarPathCommand, (wrPathError, wrPathStdout, wrPathStderr) => {
                        if (wrPathError) {
                          console.log('WinRAR (PATH) failed with error:', wrPathError.message);
                          console.log('WinRAR (PATH) stderr:', wrPathStderr);
                          console.log('WinRAR (PATH) stdout:', wrPathStdout);
                          console.log('All external tools failed, trying Node.js extraction...');
                          
                          // Node.js ile ZIP ayıklama dene
                          this.extractWithNodeJS(zipPath, targetDir)
                            .then(() => {
                              console.log('Node.js extraction successful');
                              resolve();
                            })
                            .catch((nodeError) => {
                              console.log('All extraction methods failed');
                              console.log('7-Zip error:', error.message);
                              console.log('WinRAR error:', wrError.message);
                              console.log('WinRAR Alt error:', wrAltError.message);
                              console.log('WinRAR Path error:', wrPathError.message);
                              console.log('Node.js error:', nodeError.message);
                              reject(new Error('ZIP extraction failed - tüm yöntemler başarısız'));
                            });
                        } else {
                          console.log('WinRAR (PATH) extraction successful');
                          console.log('WinRAR output:', wrPathStdout);
                          resolve();
                        }
                      });
                    } else {
                      console.log('WinRAR (x86) extraction successful');
                      console.log('WinRAR output:', wrAltStdout);
                      resolve();
                    }
                  });
                } else {
                  console.log('WinRAR extraction successful');
                  console.log('WinRAR output:', wrStdout);
                  resolve();
                }
              });
            } else {
              console.log('7-Zip extraction successful');
              console.log('7-Zip output:', stdout);
              resolve();
            }
          });
        }).catch(error => {
          console.log('Failed to create target directory:', error.message);
          reject(new Error(`Failed to create target directory: ${error.message}`));
        });
      } catch (error) {
        console.log('ZIP extraction failed:', error.message);
        reject(new Error(`ZIP extraction failed: ${error.message}`));
      }
    });
  }



  async extractWithNodeJS(zipPath, targetDir) {
    return new Promise((resolve, reject) => {
      console.log('Attempting Node.js ZIP extraction...');
      console.log('ZIP path:', zipPath);
      console.log('Target directory:', targetDir);
      
      try {
        // AdmZip ile ayıklama dene
        console.log('Trying AdmZip extraction...');
        const zip = new AdmZip(zipPath);
        
        try {
          zip.extractAllTo(targetDir, true);
          console.log('AdmZip extraction successful');
          resolve();
        } catch (extractError) {
          console.log('AdmZip extraction failed:', extractError.message);
          
          // yauzl ile dene
          console.log('Trying yauzl for ZIP...');
          yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
            if (err) {
              console.log('yauzl failed to open ZIP:', err.message);
              reject(new Error(`Node.js ZIP extraction failed: ${err.message}`));
              return;
            }
            
            let extractedCount = 0;
            let errorCount = 0;
            
            zipfile.readEntry();
            zipfile.on('entry', (entry) => {
              console.log(`yauzl processing: ${entry.fileName}`);
              
              if (/\/$/.test(entry.fileName)) {
                // Klasör
                const dirPath = path.join(targetDir, entry.fileName);
                try {
                  fs.ensureDirSync(dirPath);
                  console.log(`yauzl created directory: ${dirPath}`);
                } catch (dirError) {
                  console.log(`yauzl failed to create directory: ${dirPath}`, dirError.message);
                  errorCount++;
                }
                zipfile.readEntry();
              } else {
                // Dosya
                zipfile.openReadStream(entry, (err, readStream) => {
                  if (err) {
                    console.log(`yauzl failed to read entry: ${entry.fileName}`, err.message);
                    errorCount++;
                    zipfile.readEntry();
                    return;
                  }
                  
                  const filePath = path.join(targetDir, entry.fileName);
                  const dirPath = path.dirname(filePath);
                  
                  try {
                    fs.ensureDirSync(dirPath);
                    const writeStream = fs.createWriteStream(filePath);
                    readStream.pipe(writeStream);
                    
                    writeStream.on('close', () => {
                      console.log(`yauzl extracted file: ${filePath}`);
                      extractedCount++;
                      zipfile.readEntry();
                    });
                    
                    writeStream.on('error', (writeError) => {
                      console.log(`yauzl failed to write file: ${entry.fileName}`, writeError.message);
                      errorCount++;
                      zipfile.readEntry();
                    });
                  } catch (streamError) {
                    console.log(`yauzl failed to setup stream for: ${entry.fileName}`, streamError.message);
                    errorCount++;
                    zipfile.readEntry();
                  }
                });
              }
            });
            
            zipfile.on('end', () => {
              console.log(`yauzl extraction completed. Extracted: ${extractedCount}, Errors: ${errorCount}`);
              if (extractedCount > 0) {
                resolve();
              } else {
                reject(new Error('yauzl failed to extract any files'));
              }
            });
            
            zipfile.on('error', (yauzlError) => {
              console.log('yauzl error:', yauzlError.message);
              reject(new Error(`yauzl extraction failed: ${yauzlError.message}`));
            });
          });
        }
      } catch (error) {
        console.log('Node.js extraction failed:', error.message);
        reject(new Error(`Node.js ZIP extraction failed: ${error.message}`));
      }
    });
  }


}

// App event handlers
app.whenReady().then(async () => {
  const manager = new SteamLibraryManager();
  await manager.createWindow();
  
  // Kullanıcı oturumunu başlat
  await manager.startUserSession();
});

app.on('window-all-closed', async () => {
  // Kullanıcı oturumunu sonlandır
  if (global.steamManager) {
    await global.steamManager.endUserSession();
  }
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
  // Uygulama kapatılmadan önce oturumu sonlandır
  if (global.steamManager) {
    await global.steamManager.endUserSession();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const manager = new SteamLibraryManager();
    manager.createWindow();
  }
});