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
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');
const stream = require('stream');
const { promisify } = require('util');
const pipeline = promisify(stream.pipeline);
const http = require('http');
const https = require('https');
const url = require('url');

const USER_ACTIVITY_API = "https://api.muhammetdag.com/steamlib/session/user-activity.php";
let userSessionId = null;
let isOnline = false;

class SteamLibraryManager {
    constructor() {
    this.mainWindow = null;
    this.appDataPath = path.join(os.homedir(), 'AppData', 'Local', 'paradisedev');
    this.configPath = path.join(this.appDataPath, 'config.json');
    this.gamesDataPath = path.join(this.appDataPath, 'games.json');
    this.config = {};
    this.gamesCache = {};
    this.onlineGamesCache = { games: [], cached_at: 0 };
    this.lastApiCallAtByHost = {};
    this.discordRPC = null;
    this.repairFixMarkFile = '._repair_fix_installed.json';
    this.repairFixManifestFile = '._repair_fix_manifest.json';
    this.phpApiUrl = 'https://api.muhammetdag.com/steamlib/online/online.php';
    this.repairFixCache = new Map();
    this.repairFixCacheExpiry = 1800000; // 30 dakika (5x artırıldı)
    
    this.isBatchProcessing = false;
    this.currentBatch = 0;
    this.totalBatches = 0;
    this.processedGames = 0;
    this.totalGames = 0;
    this.httpClient = axios.create({
      timeout: 5000, // 5 saniye (3x hızlandırıldı)
      maxRedirects: 3,
      validateStatus: (status) => status === 200,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/json,text/plain,*/*',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive'
      },

      httpAgent: new http.Agent({
        keepAlive: true,
        keepAliveMsecs: 500, // Daha kısa keep-alive
        maxSockets: 20, // Daha fazla socket
        maxFreeSockets: 10, // Daha fazla free socket
        timeout: 3000 // Socket timeout
      }),
      httpsAgent: new https.Agent({
        keepAlive: true,
        keepAliveMsecs: 500, // Daha kısa keep-alive
        maxSockets: 20, // Daha fazla socket
        maxFreeSockets: 10, // Daha fazla free socket
        timeout: 3000 // Socket timeout
      })
    });
    
    this.httpClient.interceptors.request.use(async (config) => {
      if (config.url && config.url.includes('online.php')) {
        try {
          const token = await this.getStoredToken();
          if (token) {
            config.headers['Authorization'] = `Bearer ${token}`;
            console.log('🔐 Bearer token otomatik eklendi');
          }
        } catch (error) {
          console.error('Token eklenirken hata:', error);
        }
      }
      return config;
    });
    
    this.httpClient.interceptors.response.use(
      response => response,
      async error => {
        if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
          console.log('🔄 Timeout hatası, yeniden deneniyor...');
          try {
            const config = error.config;
            config.timeout = 3000; // Daha kısa timeout ile dene
            return await this.httpClient.request(config);
          } catch (retryError) {
            throw retryError;
          }
        }
        throw error;
      }
    );
    

    ipcMain.handle('get-cache-stats', () => {
      return {
        onlineFixCacheSize: this.repairFixCache.size,
        steamApiCacheSize: this.steamApiCache.size,
        onlineFixCacheExpiry: this.repairFixCacheExpiry,
        steamApiCacheExpiry: this.steamApiCacheExpiry
      };
    });
    

    ipcMain.handle('check-multiple-repair-fix', async (event, folderNames) => {
      return await this.checkMultipleRepairFixAvailable(folderNames);
    });
    
    ipcMain.handle('list-multiple-repair-fix', async (event, folderNames) => {
      return await this.listMultipleRepairFixFiles(folderNames);
    });
    

    ipcMain.handle('get-batch-progress', () => {
      return {
        isProcessing: this.isBatchProcessing || false,
        currentBatch: this.currentBatch || 0,
        totalBatches: this.totalBatches || 0,
        processedGames: this.processedGames || 0,
        totalGames: this.totalGames || 0
      };
    });
    

    this.steamApiCache = new Map();
    this.steamApiCacheExpiry = 3600000; // 1 saat
    this.batchApiQueue = [];
    this.batchApiTimeout = null;
    
    this.steamSetupStatus = {
      hasSteamPath: false,
      hasHidDll: false,
      directoriesCreated: false,
      steamPath: null
    };

    this.init();
    

    this.clearOldCache().catch(error => {
      console.error('Cache temizleme başlatılamadı:', error.message);
    });
    
    this.refreshStaleCache().catch(error => {
      console.error('Cache yenileme başlatılamadı:', error.message);
    });
    

    this.preloadOnlineFixCache();
    

    ipcMain.handle('save-discord-token', async (event, token, user) => {
      try {
        console.log('Discord token kaydediliyor...');
        

        let config = {};
        if (await fs.pathExists(this.configPath)) {
          config = await fs.readJson(this.configPath);
        }
        

        config.discord = {
          token: token,
          user: user,
          timestamp: Date.now()
        };
        

        await fs.writeJson(this.configPath, config, { spaces: 2 });
        console.log('✅ Discord token config.json dosyasına kaydedildi');
        

        this.config = config;
        
        return { success: true };
      } catch (error) {
        console.error('❌ Discord token kaydetme hatası:', error);
        return { success: false, error: error.message };
      }
    });
    

    ipcMain.handle('get-discord-token', async (event) => {
      try {

        if (this.config && this.config.discord && this.config.discord.token) {
          const tokenData = {
            token: this.config.discord.token,
            user: this.config.discord.user,
            timestamp: this.config.discord.timestamp
          };
          
          console.log('✅ Discord token config\'den alındı');
          return { success: true, data: tokenData };
        } else {
          console.log('❌ Discord token config\'de bulunamadı');
          return { success: false, message: 'Token not found' };
        }
      } catch (error) {
        console.error('❌ Discord token alma hatası:', error);
        return { success: false, error: error.message };
      }
    });
    
    ipcMain.handle('clear-discord-token', async (event) => {
      try {
        console.log('Discord token temizleniyor...');
        
        if (this.config && this.config.discord) {
          delete this.config.discord;
          
          await fs.writeJson(this.configPath, this.config, { spaces: 2 });
          console.log('✅ Discord token config.json\'dan temizlendi');
        }
        
        return { success: true };
      } catch (error) {
        console.error('❌ Discord token temizleme hatası:', error);
        return { success: false, error: error.message };
      }
    });
    

  }

  async getStoredToken() {
    try {
      if (this.config && this.config.discord && this.config.discord.token) {
        const tokenData = this.config.discord.token;
        const timestamp = this.config.discord.timestamp;
        
        if (timestamp && (Date.now() - timestamp) < (24 * 60 * 60 * 1000)) {
          return tokenData;
        }
      }
      return null;
    } catch (error) {
      console.error('Token alınırken hata:', error);
      return null;
    }
  }

  async openUrlInChrome(url) {
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
    } catch (e) {
    }

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
      } catch (e) {
      }
    }

    await shell.openExternal(url);
    return true;
  }

  async getCacheStats() {
    try {
      const cacheDir = path.join(this.appDataPath, 'steam-cache');
      if (!await fs.pathExists(cacheDir)) {
        return { total: 0, memory: 0, files: 0, fresh: 0, stale: 0 };
      }
      
      const files = await fs.readdir(cacheDir);
      const jsonFiles = files.filter(file => file.endsWith('.json'));
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 1 gün
      
      let freshCount = 0;
      let staleCount = 0;
      
      for (const file of jsonFiles) {
        try {
          const filePath = path.join(cacheDir, file);
          const fileData = await fs.readJson(filePath);
          const cacheAge = now - fileData.timestamp;
          
          if (cacheAge < maxAge) {
            freshCount++;
          } else {
            staleCount++;
          }
        } catch (error) {
        }
      }
      
      return {
        total: this.steamApiCache.size + jsonFiles.length,
        memory: this.steamApiCache.size,
        files: jsonFiles.length,
        fresh: freshCount,
        stale: staleCount
      };
    } catch (error) {
      console.error('Cache istatistik hatası:', error.message);
      return { total: 0, memory: 0, files: 0, fresh: 0, stale: 0 };
    }
  }

  async refreshStaleCache() {
    try {
      const cacheDir = path.join(this.appDataPath, 'steam-cache');
      if (!await fs.pathExists(cacheDir)) return;
      
      const files = await fs.readdir(cacheDir);
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 1 gün
      let refreshedCount = 0;
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(cacheDir, file);
          try {
            const fileData = await fs.readJson(filePath);
            const cacheAge = now - fileData.timestamp;
            
            if (cacheAge > maxAge) {
              const appId = fileData.appId;
              console.log(`🔄 Eski cache yenileniyor: ${appId}`);
              
              try {
                const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=TR&l=english`;
                const response = await axios.get(url, { 
                  timeout: 10000,
                  headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
                  }
                });
                
                if (response.data && response.data[appId] && response.data[appId].success) {
                  const gameData = response.data[appId].data;
                  const updatedGame = {
                    appid: appId,
                    name: gameData.name || `Game ${appId}`,
                    developers: gameData.developers || [],
                    publishers: gameData.publishers || [],
                    release_date: gameData.release_date || { date: 'Bilinmiyor' },
                    price_overview: gameData.price_overview || null,
                    is_free: gameData.is_free || false,
                    short_description: gameData.short_description || '',
                    about_the_game: gameData.about_the_game || '',
                    detailed_description: gameData.detailed_description || '',
                    screenshots: gameData.screenshots || [],
                    movies: gameData.movies || [],
                    genres: gameData.genres || [],
                    recommendations: gameData.recommendations || { total: 0 },
                    header_image: gameData.header_image || '',
                    background: gameData.background || ''
                  };
                  
                  await this.setCachedGameData(appId, updatedGame);
                  refreshedCount++;
                  
                  await new Promise(resolve => setTimeout(resolve, 500));
                }
              } catch (error) {
                console.error(`Cache yenileme hatası ${appId}:`, error.message);
              }
            }
          } catch (error) {
            await fs.remove(filePath);
            console.log(`🗑️ Bozuk cache silindi: ${file}`);
          }
        }
      }
      
      if (refreshedCount > 0) {
        console.log(`🔄 Toplam ${refreshedCount} cache yenilendi`);
      }
      
    } catch (error) {
      console.error('Cache yenileme hatası:', error.message);
    }
  }

  async clearOldCache() {
    try {
      const cacheDir = path.join(this.appDataPath, 'steam-cache');
      if (!await fs.pathExists(cacheDir)) return;
      
      const files = await fs.readdir(cacheDir);
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 1 gün
      
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(cacheDir, file);
          try {
            const fileData = await fs.readJson(filePath);
            if (now - fileData.timestamp > maxAge) {
              await fs.remove(filePath);
              console.log(`🗑️ Eski cache temizlendi: ${file}`);
            }
          } catch (error) {
            await fs.remove(filePath);
            console.log(`🗑️ Bozuk cache silindi: ${file}`);
          }
        }
      }
      
      const now2 = Date.now();
      for (const [key, value] of this.repairFixCache.entries()) {
        if (now2 - value.timestamp > this.repairFixCacheExpiry) {
          this.repairFixCache.delete(key);
          console.log(`🗑️ Online fix cache temizlendi: ${key}`);
        }
      }
      
    } catch (error) {
      console.error('Cache temizleme hatası:', error.message);
    }
  }

  async getCachedGameData(appId) {
    try {
      const memoryCached = this.steamApiCache.get(appId);
      if (memoryCached && (Date.now() - memoryCached.timestamp) < this.steamApiCacheExpiry) {
        if (memoryCached.data.isError) {
          console.log(`🚫 Cache'den 403 hatası alındı: ${appId} (${memoryCached.data.errorType})`);
          return memoryCached.data;
        }
        return memoryCached.data;
      }
      
      const cacheDir = path.join(this.appDataPath, 'steam-cache');
      const cacheFile = path.join(cacheDir, `${appId}.json`);
      
      if (await fs.pathExists(cacheFile)) {
        const fileData = await fs.readJson(cacheFile);
        
        const cacheAge = Date.now() - fileData.timestamp;
        const maxAge = 24 * 60 * 60 * 1000; // 1 gün
        
        if (cacheAge < maxAge) {
          this.steamApiCache.set(appId, {
            data: fileData.data,
            timestamp: fileData.timestamp
          });
          
          if (fileData.data.isError) {
            console.log(`🚫 Dosya cache'den 403 hatası yüklendi: ${appId} (${fileData.data.errorType})`);
            return fileData.data;
          }
          
          console.log(`📁 Dosya cache'den yüklendi: ${appId} -> ${fileData.data.name}`);
          return fileData.data;
        } else {
          await fs.remove(cacheFile);
          console.log(`🗑️ Eski cache silindi: ${appId}`);
        }
      }
      
      return null;
      
    } catch (error) {
      console.error(`Cache okuma hatası ${appId}:`, error.message);
      return null;
    }
  }

  async setCachedGameData(appId, data) {
    try {
      this.steamApiCache.set(appId, {
        data: data,
        timestamp: Date.now()
      });
      
      const cacheDir = path.join(this.appDataPath, 'steam-cache');
      await fs.ensureDir(cacheDir);
      
      const cacheFile = path.join(cacheDir, `${appId}.json`);
      const cacheData = {
        appId: appId,
        data: data,
        timestamp: Date.now(),
        lastUpdated: new Date().toISOString()
      };
      
      await fs.writeJson(cacheFile, cacheData, { spaces: 2 });
      console.log(`💾 Cache kaydedildi: ${appId} -> ${data.name}`);
      
    } catch (error) {
      console.error(`Cache kaydetme hatası ${appId}:`, error.message);
    }
  }

  addToBatchQueue(appId, resolve, reject) {
    this.batchApiQueue.push({ appId, resolve, reject });
    
    if (!this.batchApiTimeout) {
      this.batchApiTimeout = setTimeout(() => {
        this.processBatchQueue();
      }, 200); // 200ms sonra işlemi başlat
    }
  }

  async processBatchQueue() {
    if (this.batchApiQueue.length === 0) return;
    
    const currentBatch = this.batchApiQueue.splice(0, 5); // Maksimum 5 oyun işle
    
    for (const { appId, resolve, reject } of currentBatch) {
      try {
        console.log(`Main: Tek tek API çağrısı: ${appId}`);
        
        const cachedData = await this.getCachedGameData(appId);
        if (cachedData) {
          console.log(`✅ Cache hit: ${cachedData.name} (${appId})`);
          resolve(cachedData);
          continue;
        }
        
        const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=TR&l=english`;
        const response = await axios.get(url, { 
          timeout: 10000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });
        
        if (response.data && response.data[appId] && response.data[appId].success) {
          const gameData = response.data[appId].data;
          const formattedGame = {
            appid: appId,
            name: gameData.name || `Game ${appId}`,
            developers: gameData.developers || [],
            publishers: gameData.publishers || [],
            release_date: gameData.release_date || { date: 'Bilinmiyor' },
            price_overview: gameData.price_overview || null,
            is_free: gameData.is_free || false,
            short_description: gameData.short_description || '',
            about_the_game: gameData.about_the_game || '',
            detailed_description: gameData.detailed_description || '',
            screenshots: gameData.screenshots || [],
            movies: gameData.movies || [],
            genres: gameData.genres || [],
            recommendations: gameData.recommendations || { total: 0 },
            header_image: gameData.header_image || '',
            background: gameData.background || '',
            platforms: gameData.platforms || {},
            categories: gameData.categories || [],
            metacritic: gameData.metacritic || null,
            dlc: gameData.dlc || [],
            price: gameData.price_overview ? gameData.price_overview.final : 0,
            discount_percent: gameData.price_overview ? gameData.price_overview.discount_percent : 0
          };
          
          await this.setCachedGameData(appId, formattedGame);
          console.log(`✅ Steam API: ${formattedGame.name} (${appId})`);
          resolve(formattedGame);
        } else {
          const fallbackGame = {
            appid: appId,
            name: `Game ${appId}`,
            developers: [],
            publishers: [],
            release_date: { date: 'Bilinmiyor' },
            price_overview: null,
            is_free: false,
            short_description: '',
            about_the_game: '',
            detailed_description: '',
            screenshots: [],
            movies: [],
            genres: [],
            recommendations: { total: 0 },
            header_image: '',
            background: '',
            platforms: {},
            categories: [],
            metacritic: null,
            dlc: [],
            price: 0,
            discount_percent: 0
          };
          
          await this.setCachedGameData(appId, fallbackGame);
          console.log(`⚠️ Fallback: Game ${appId}`);
          resolve(fallbackGame);
        }
        
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (error) {
        console.error(`Main: API hatası ${appId}:`, error.message);
        
        const fallbackGame = {
          appid: appId,
          name: `Game ${appId}`,
          developers: [],
          publishers: [],
          release_date: { date: 'Bilinmiyor' },
          price_overview: null,
          is_free: false,
          short_description: '',
          about_the_game: '',
          detailed_description: '',
          screenshots: [],
          movies: [],
          genres: [],
          recommendations: { total: 0 },
          header_image: '',
          background: '',
          platforms: {},
          categories: [],
          metacritic: null,
          dlc: [],
          price: 0,
          discount_percent: 0
        };
        
        await this.setCachedGameData(appId, fallbackGame);
        console.log(`⚠️ Hata fallback: Game ${appId}`);
        resolve(fallbackGame);
      }
    }
    
    if (this.batchApiQueue.length > 0) {
      this.batchApiTimeout = setTimeout(() => {
        this.processBatchQueue();
      }, 1000); // 1 saniye gecikme
    } else {
      this.batchApiTimeout = null;
    }
  }

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
    } catch (e) {
    }
  }

  async checkRepairFixAvailable(folderName) {
    try {
      const cacheKey = `check_${folderName}`;

      return await this.getCachedOrFetch(cacheKey, async () => {
      const url = `${this.phpApiUrl}?action=check&folder=${encodeURIComponent(folderName)}`;
      
        const res = await this.httpClient.get(url, { 
          timeout: 5000
      });
      const result = res.data.available === true;
      
      console.log(`API call for ${folderName} check, result: ${result}`);
      return result;
      });
    } catch (e) {
      console.error('PHP API check error:', e);
      
      if (e.response && e.response.status === 401) {
        console.log('401 hatası algılandı, renderer\'a bildirim gönderiliyor');
        if (this.mainWindow && !this.onlineFix401Sent) {
          this.onlineFix401Sent = true; // Flag set et
          this.mainWindow.webContents.send('online-fix-401-error');
          
          setTimeout(() => {
            this.onlineFix401Sent = false;
          }, 5000);
        }
      }
      
      return false;
    }
  }

  async listRepairFixFiles(folderName) {
    try {
      const cacheKey = `list_${folderName}`;

      return await this.getCachedOrFetch(cacheKey, async () => {
      const url = `${this.phpApiUrl}?action=list&folder=${encodeURIComponent(folderName)}`;
      
        const res = await this.httpClient.get(url, { 
          timeout: 5000
      });
      const result = res.data.files || '';
      
      console.log(`API call for ${folderName} list, result length: ${result.length}`);
      return result;
      });
    } catch (e) {
      console.error('PHP API list error:', e);
      return '';
    }
  }

  async downloadRepairFixFile(folderName, fileName) {
    try {
      const url = `${this.phpApiUrl}?action=download&folder=${encodeURIComponent(folderName)}&file=${encodeURIComponent(fileName)}`;
      console.log(`Downloading from PHP API: ${url}`);
      
      const headers = {
        'Referer': 'https://online-fix.me',
        'Origin': 'https://online-fix.me',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        'Accept': 'application/octet-stream,*/*',
        'Accept-Encoding': 'identity'
      };
      
      const res = await this.httpClient.get(url, { 
        responseType: 'stream', 
        timeout: 30000,
        headers
      });
      
      console.log(`Download response received: ${res.status} ${res.statusText}`);
      console.log(`Content-Type: ${res.headers['content-type']}`);
      console.log(`Content-Length: ${res.headers['content-length']}`);
      
      return res.data;
    } catch (e) {
      console.error('PHP API download error:', e);
      if (e.response) {
        console.error('Response status:', e.response.status);
        console.error('Response headers:', e.response.headers);
        console.error('Response data:', e.response.data);
      }
      throw e;
    }
  }

  async preloadOnlineFixCache() {
    try {
      console.log('🚀 Cache preload başlatılıyor...');
      
      const installedGames = await this.getLibraryGames();
      if (!installedGames || installedGames.length === 0) {
        console.log('⚠️ Kurulu oyun bulunamadı, cache preload atlandı');
        return { checkResults: {}, listResults: {} };
      }
      
      const gameFolders = installedGames.map(game => game.folderName).filter(folder => folder);
      
      if (gameFolders.length === 0) {
        console.log('⚠️ Geçerli oyun klasörü bulunamadı, cache preload atlandı');
        return { checkResults: {}, listResults: {} };
      }
      
      console.log(`🚀 ${gameFolders.length} kurulu oyun için cache preload başlatılıyor...`);
      
      const checkResults = await this.checkMultipleRepairFixAvailable(gameFolders);
      const listResults = await this.listMultipleRepairFixFiles(gameFolders);
      
      console.log('✅ Online fix cache preload tamamlandı (batch processing ile)');
      return { checkResults, listResults };
    } catch (error) {
      console.error('❌ Cache preload hatası:', error);
      return {};
    }
  }
  
  async checkMultipleRepairFixAvailable(folderNames) {
    try {
      const totalGames = folderNames.length;
      const batchSize = 100; // Maksimum batch boyutu
      
      this.isBatchProcessing = true;
      this.totalGames = totalGames;
      this.processedGames = 0;
      
      console.log(`🔍 ${totalGames} oyun için paralel check başlatılıyor...`);
      
      if (totalGames <= batchSize) {
        console.log(`📦 Tek batch: ${totalGames} oyun`);
        this.totalBatches = 1;
        this.currentBatch = 1;
        
        const results = await this.processBatchCheck(folderNames);
        this.processedGames = totalGames;
        this.isBatchProcessing = false;
        return results;
      } else {
        const batches = this.chunkArray(folderNames, batchSize);
        this.totalBatches = batches.length;
        console.log(`📦 ${batches.length} batch'e bölündü (${batchSize} oyun/batch)`);
        
        const allResults = {};
        
        for (let i = 0; i < batches.length; i++) {
          const batch = batches[i];
          this.currentBatch = i + 1;
          console.log(`🔄 Batch ${i + 1}/${batches.length} işleniyor (${batch.length} oyun)...`);
          
          const batchResults = await this.processBatchCheck(batch);
          Object.assign(allResults, batchResults);
          
          this.processedGames += batch.length;
          
          if (i < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        
        console.log(`✅ Tüm ${totalGames} oyun check tamamlandı (${batches.length} batch)`);
        this.isBatchProcessing = false;
        return allResults;
      }
    } catch (error) {
      console.error('❌ Paralel check hatası:', error);
      this.isBatchProcessing = false;
      return {};
    }
  }
  
  async listMultipleRepairFixFiles(folderNames) {
    try {
      const totalGames = folderNames.length;
      const batchSize = 100; // Maksimum batch boyutu
      
      this.isBatchProcessing = true;
      this.totalGames = totalGames;
      this.processedGames = 0;
      
      console.log(`📋 ${totalGames} oyun için paralel list başlatılıyor...`);
      
      if (totalGames <= batchSize) {
        console.log(`📦 Tek batch: ${totalGames} oyun`);
        this.totalBatches = 1;
        this.currentBatch = 1;
        
        const results = await this.processBatchList(folderNames);
        this.processedGames = totalGames;
        this.isBatchProcessing = false;
        return results;
      } else {
        const batches = this.chunkArray(folderNames, batchSize);
        this.totalBatches = batches.length;
        console.log(`📦 ${batches.length} batch'e bölündü (${batchSize} oyun/batch)`);
        
        const allResults = {};
        
        for (let i = 0; i < batches.length; i++) {
          const batch = batches[i];
          this.currentBatch = i + 1;
          console.log(`🔄 Batch ${i + 1}/${batches.length} işleniyor (${batch.length} oyun)...`);
          
          const batchResults = await this.processBatchList(batch);
          Object.assign(allResults, batchResults);
          
          this.processedGames += batch.length;
          
          if (i < batches.length - 1) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }
        
        console.log(`✅ Tüm ${totalGames} oyun list tamamlandı (${batches.length} batch)`);
        this.isBatchProcessing = false;
        return allResults;
      }
    } catch (error) {
      console.error('❌ Paralel list hatası:', error);
      this.isBatchProcessing = false;
      return {};
    }
  }
  
  chunkArray(array, size) {
    const chunks = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }
  
  async processBatchCheck(folderNames) {
    try {
      const promises = folderNames.map(folderName => 
        this.checkRepairFixAvailable(folderName)
      );
      
      const results = await Promise.all(promises);
      
      const resultMap = {};
      folderNames.forEach((folderName, index) => {
        resultMap[folderName] = results[index];
      });
      
      return resultMap;
    } catch (error) {
      console.error('❌ Batch check hatası:', error);
      return {};
    }
  }
  
  async processBatchList(folderNames) {
    try {
      const promises = folderNames.map(folderName => 
        this.listRepairFixFiles(folderName)
      );
      
      const results = await Promise.all(promises);
      
      const resultMap = {};
      folderNames.forEach((folderName, index) => {
        resultMap[folderName] = results[index];
      });
      
      return resultMap;
    } catch (error) {
      console.error('❌ Batch list hatası:', error);
      return {};
    }
  }

  async getCachedOrFetch(key, fetchFunction, expiry = this.repairFixCacheExpiry) {
    const cached = this.repairFixCache.get(key);
    if (cached && (Date.now() - cached.timestamp) < expiry) {
      return cached.result;
    }
    
    try {
      const result = await fetchFunction();
      this.repairFixCache.set(key, {
        result: result,
        timestamp: Date.now()
      });
      return result;
    } catch (error) {
      if (cached) {
        console.log(`Cache fallback for ${key}`);
        return cached.result;
      }
      throw error;
    }
  }

  async backupBeforeExtract(targetDir) {
    try {
      const backupDir = path.join(targetDir, '._repair_fix_backup');
      await fs.ensureDir(backupDir);
      
      const files = await fs.readdir(targetDir);
      const backupInfo = {
        timestamp: new Date().toISOString(),
        originalFiles: [],
        backupPath: backupDir
      };
      
      for (const file of files) {
        if (file !== '._repair_fix_backup' && file !== '._repair_fix_installed.json') {
          const sourcePath = path.join(targetDir, file);
          const backupPath = path.join(backupDir, file);
          const stat = await fs.stat(sourcePath);
          
          if (stat.isFile()) {
            await fs.copy(sourcePath, backupPath);
            backupInfo.originalFiles.push({
              name: file,
              size: stat.size,
              modified: stat.mtime
            });
          } else if (stat.isDirectory()) {
            await fs.copy(sourcePath, backupPath);
            backupInfo.originalFiles.push({
              name: file,
              type: 'directory',
              modified: stat.mtime
            });
          }
        }
      }
      
      const backupInfoFile = path.join(targetDir, '._repair_fix_backup_info.json');
      await fs.writeJson(backupInfoFile, backupInfo, { spaces: 2 });
      
      console.log(`Backup created: ${backupInfo.originalFiles.length} files/directories backed up`);
      return backupInfo;
    } catch (e) {
      console.error('Backup error:', e);
      throw e;
    }
  }

  async getArchiveEntries(archivePath) {
    try {
      const ext = path.extname(archivePath).toLowerCase();
      console.log(`🔍 Arşiv formatı tespit edildi: ${ext}`);
      const entries = [];
      
      if (ext === '.zip') {
        console.log('📦 ZIP dosyası işleniyor...');
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(archivePath);
        const zipEntries = zip.getEntries();
        console.log(`📋 ZIP'den ${zipEntries.length} entry bulundu`);
        
        for (const entry of zipEntries) {
          entries.push({
            entryName: entry.entryName,
            isDirectory: entry.isDirectory,
            size: entry.header.size
          });
          console.log(`  - ${entry.entryName} (${entry.isDirectory ? 'Klasör' : 'Dosya'})`);
        }
      } else if (ext === '.rar' || ext === '.7z') {
        console.log(`📦 ${ext.toUpperCase()} dosyası işleniyor...`);
        try {
          const { exec } = require('child_process');
          const { promisify } = require('util');
          const execAsync = promisify(exec);
          
          const sevenZipPaths = [
            'C:\\Program Files\\7-Zip\\7z.exe',
            'C:\\Program Files (x86)\\7-Zip\\7z.exe',
            '7z.exe'
          ];
          
          let sevenZipExe = null;
          for (const path of sevenZipPaths) {
            try {
              if (require('fs').existsSync(path)) {
                sevenZipExe = path;
                console.log(`✅ 7-Zip bulundu: ${path}`);
                break;
              }
            } catch (e) {
            }
          }
          
          if (sevenZipExe) {
            console.log(`🔍 7-Zip ile arşiv içeriği listeleniyor...`);
            try {
              const result = await execAsync(`"${sevenZipExe}" l "${archivePath}"`, { 
                windowsHide: true,
                maxBuffer: 1024 * 1024 * 10 // 10MB buffer
              });
              
              console.log(`📋 7-Zip stdout:`, result.stdout);
              console.log(`📋 7-Zip stderr:`, result.stderr);
              
              const lines = result.stdout.split('\n');
              console.log(`📋 7-Zip çıktısı: ${lines.length} satır`);
              
              for (const line of lines) {
                const trimmedLine = line.trim();
                if (trimmedLine && !trimmedLine.includes('----') && !trimmedLine.includes('Type') && !trimmedLine.includes('Date') && !trimmedLine.includes('7-Zip')) {
                  const parts = trimmedLine.split(/\s+/);
                  console.log(`🔍 Satır parse ediliyor: "${trimmedLine}" -> Parts:`, parts);
                  
                  if (parts.length >= 3) {
                    const sizeStr = parts[0];
                    const fileName = parts.slice(3).join(' '); // Boşluklu dosya adları için
                    
                    if (fileName && fileName !== 'Name' && fileName !== 'Type' && fileName !== 'Modified' && fileName !== 'Attributes') {
                      const isDirectory = sizeStr === '<DIR>' || fileName.endsWith('/') || fileName.endsWith('\\');
                      const size = sizeStr === '<DIR>' ? 0 : parseInt(sizeStr) || 0;
                      
                      entries.push({
                        entryName: fileName,
                        isDirectory: isDirectory,
                        size: size
                      });
                      console.log(`  ✅ ${fileName} (${isDirectory ? 'Klasör' : 'Dosya'}) - Boyut: ${size}`);
                    }
                  }
                }
              }
            } catch (execError) {
              console.error('❌ 7-Zip komut hatası:', execError.message);
              console.error('❌ 7-Zip stderr:', execError.stderr);
            }
          } else {
            console.warn('⚠️ 7-Zip bulunamadı, RAR/7Z içerik listesi alınamayacak');
          }
        } catch (archiveError) {
          console.error('❌ RAR/7Z içerik listesi hatası:', archiveError.message);
        }
      } else if (ext === '.tar' || ext === '.tar.gz' || ext === '.tgz') {
        console.log('📦 TAR dosyası işleniyor...');
        try {
          const { exec } = require('child_process');
          const { promisify } = require('util');
          const execAsync = promisify(exec);
          
          const result = await execAsync(`tar -tf "${archivePath}"`, { windowsHide: true });
          const lines = result.stdout.split('\n');
          
          for (const line of lines) {
            if (line.trim()) {
              entries.push({
                entryName: line.trim(),
                isDirectory: line.endsWith('/'),
                size: 0
              });
              console.log(`  - ${line.trim()} (${line.endsWith('/') ? 'Klasör' : 'Dosya'})`);
            }
          }
        } catch (tarError) {
          console.error('❌ TAR içerik listesi hatası:', tarError.message);
        }
      } else {
        console.warn(`⚠️ Desteklenmeyen arşiv formatı: ${ext}`);
      }
      
      console.log(`📦 Arşiv içeriği: ${entries.length} dosya/klasör bulundu`);
      if (entries.length === 0) {
        console.warn('⚠️ Hiç dosya bulunamadı! Arşiv boş olabilir veya okunamıyor.');
      }
      return entries;
    } catch (error) {
      console.error('❌ Arşiv içerik okuma hatası:', error);
      return [];
    }
  }

  async extractArchiveWithPassword(archivePath, targetDir, password) {
    try {
      if (process.platform === 'win32') {
        try {
          await this.extractWith7Zip(archivePath, targetDir, password);
          return;
        } catch (e) {
          console.log('7-Zip extraction failed, trying Node.js:', e.message);
        }
      }
      
      await this.extractWithNodeJS(archivePath, targetDir, password);
    } catch (e) {
      throw new Error(`Archive extraction failed: ${e.message}`);
    }
  }

  async extractWith7Zip(archivePath, targetDir, password) {
    return new Promise((resolve, reject) => {
      const { spawn } = require('child_process');
      
      const sevenZipPaths = [
        'C:\\Program Files\\7-Zip\\7z.exe',
        'C:\\Program Files (x86)\\7-Zip\\7z.exe',
        '7z.exe' // PATH'te varsa
      ];
      
      let sevenZipExe = null;
      for (const path of sevenZipPaths) {
        try {
          if (require('fs').existsSync(path)) {
            sevenZipExe = path;
            break;
          }
        } catch (e) {
        }
      }
      
      if (!sevenZipExe) {
        reject(new Error('7-Zip not found'));
        return;
      }
      
      const args = ['x', archivePath, `-o${targetDir}`, `-p${password}`, '-y'];
      const process = spawn(sevenZipExe, args);
      
      process.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`7-Zip extraction failed with code ${code}`));
        }
      });
      
      process.on('error', (err) => {
        reject(new Error(`7-Zip process error: ${err.message}`));
      });
    });
  }

  async listArchiveEntriesWith7z(archivePath, password) {
    try {
      const sevenZipCandidates = [
        'C\\\\Program Files\\\\7-Zip\\\\7z.exe',
        'C\\\\Program Files (x86)\\\\7-Zip\\\\7z.exe',
        '7z'
      ];
      let sevenZipCmd = null;
      for (const candidate of sevenZipCandidates) {
        try {
          await new Promise((resolve, reject) => {
            const p = exec(`${candidate} -h`, (err) => {
              if (err) return reject(err);
              resolve();
            });
          });
          sevenZipCmd = candidate;
          break;
        } catch (e) {
        }
      }
      if (!sevenZipCmd) return [];

      const listCmd = `${sevenZipCmd} l -slt -p"${password}" "${archivePath}"`;
      const { stdout } = await new Promise((resolve, reject) => {
        exec(listCmd, { maxBuffer: 1024 * 1024 * 10 }, (err, stdout, stderr) => {
          if (err) return resolve({ stdout: '' }); // liste alınamazsa sessizce devam et
          resolve({ stdout });
        });
      });
      if (!stdout) return [];
      const lines = stdout.split(/\r?\n/);
      const files = [];
      let currentPath = null;
      let isFolder = false;
      for (const line of lines) {
        if (line.startsWith('Path = ')) {
          currentPath = line.replace('Path = ', '').trim();
          isFolder = false;
        } else if (line.startsWith('Folder = ')) {
          isFolder = line.includes('Yes');
          if (currentPath && !isFolder) {
            files.push(currentPath.replace(/^\\+|^\/+/, ''));
          }
        }
      }
      return Array.from(new Set(files));
    } catch (e) {
      return [];
    }
  }

  async markRepairFixInstalled(targetDir) {
    try {
      const markFile = path.join(targetDir, this.repairFixMarkFile);
      const markData = {
        installed_at: new Date().toISOString(),
        version: '1.0'
      };
      await fs.writeJson(markFile, markData);
    } catch (e) {
      console.error('Mark installation error:', e);
    }
  }

  async writeRepairFixManifest(targetDir, fileList, sourceArchive) {
    try {
      const manifestPath = path.join(targetDir, this.repairFixManifestFile);
      const data = {
        archive: path.basename(sourceArchive || ''),
        files: fileList || [],
        totalFiles: fileList ? fileList.length : 0,
        updated_at: new Date().toISOString()
      };
      await fs.writeJson(manifestPath, data, { spaces: 2 });
      console.log(`📝 Manifest kaydedildi: ${data.totalFiles} dosya listelendi`);
    } catch (e) {
      console.error('Write manifest error:', e);
    }
  }

  async readRepairFixManifest(targetDir) {
    try {
      const manifestPath = path.join(targetDir, this.repairFixManifestFile);
      if (!(await fs.pathExists(manifestPath))) return null;
      return await fs.readJson(manifestPath);
    } catch (e) {
      return null;
    }
  }

  async snapshotDirFiles(rootDir) {
    const out = new Map();
    const walk = async (dir) => {
      let entries = [];
      try { 
        entries = await fs.readdir(dir); 
      } catch (e) { 
        return; 
      }
      await Promise.all(entries.map(async (name) => {
        const full = path.join(dir, name);
        let st;
        try { 
          st = await fs.stat(full); 
        } catch (e) { 
          return; 
        }
        if (st.isDirectory()) {
          await walk(full);
        } else if (st.isFile()) {
          const rel = full.substring(rootDir.length + 1).replace(/\\/g, '/');
          out.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
        }
      }));
    };
    await walk(rootDir);
    return out;
  }

  computeDiff(prevMap, postMap) {
    const changed = [];
    for (const [rel, meta] of postMap.entries()) {
      const before = prevMap.get(rel);
      if (!before || before.size !== meta.size || Math.abs((before.mtimeMs || 0) - (meta.mtimeMs || 0)) > 1) {
        changed.push(rel);
      }
    }
    return changed.sort();
  }

  async getInstalledFiles(targetDir) {
    try {
      const files = [];
      const scanDir = async (dir) => {
        const entries = await fs.readdir(dir);
        for (const entry of entries) {
          const fullPath = path.join(dir, entry);
          const stat = await fs.stat(fullPath);
          if (stat.isFile()) {
            files.push(fullPath.replace(targetDir, '').replace(/\\/g, '/'));
          } else if (stat.isDirectory() && !entry.startsWith('._')) {
            await scanDir(fullPath);
          }
        }
      };
      await scanDir(targetDir);
      return files;
    } catch (e) {
      console.error('Get installed files error:', e);
      return [];
    }
  }

  async restoreFromBackup(targetDir) {
    try {
      const backupDir = path.join(targetDir, '._repair_fix_backup');
      const backupInfoFile = path.join(targetDir, '._repair_fix_backup_info.json');
      
      if (!await fs.pathExists(backupDir)) {
        throw new Error('Backup directory not found');
      }
      
      if (!await fs.pathExists(backupInfoFile)) {
        throw new Error('Backup info file not found');
      }
      
      const backupInfo = await fs.readJson(backupInfoFile);
      console.log(`Restoring ${backupInfo.originalFiles.length} files/directories from backup`);
      
      const currentFiles = await fs.readdir(targetDir);
      for (const file of currentFiles) {
        if (file !== '._repair_fix_backup' && file !== '._repair_fix_backup_info.json' && file !== '._repair_fix_installed.json') {
          const filePath = path.join(targetDir, file);
          const stat = await fs.stat(filePath);
          if (stat.isFile()) {
            await fs.remove(filePath);
          } else if (stat.isDirectory()) {
            await fs.remove(filePath);
          }
        }
      }
      
      for (const fileInfo of backupInfo.originalFiles) {
        const backupPath = path.join(backupDir, fileInfo.name);
        const targetPath = path.join(targetDir, fileInfo.name);
        
        if (await fs.pathExists(backupPath)) {
          if (fileInfo.type === 'directory') {
            await fs.copy(backupPath, targetPath);
          } else {
            await fs.copy(backupPath, targetPath);
          }
          console.log(`Restored: ${fileInfo.name}`);
        }
      }
      
      await fs.remove(backupDir);
      await fs.remove(backupInfoFile);
      
      console.log('Restore completed successfully');
    } catch (e) {
      console.error('Restore from backup error:', e);
      throw e;
    }
  }

  async unmarkRepairFix(targetDir) {
    try {
      const markFile = path.join(targetDir, this.repairFixMarkFile);
      if (await fs.pathExists(markFile)) {
        await fs.remove(markFile);
      }
    } catch (e) {
      console.error('Unmark repair fix error:', e);
    }
  }

  clearRepairFixCache(folderName = null) {
    if (folderName) {
      this.repairFixCache.delete(`check_${folderName}`);
      this.repairFixCache.delete(`list_${folderName}`);
      console.log(`Cache cleared for ${folderName}`);
    } else {
      this.repairFixCache.clear();
      console.log('All repair fix cache cleared');
    }
  }

  getRepairFixCacheStatus() {
    const status = {};
    for (const [key, value] of this.repairFixCache.entries()) {
      const age = Date.now() - value.timestamp;
      const expired = age > this.repairFixCacheExpiry;
      status[key] = {
        age: Math.round(age / 1000) + 's',
        expired: expired,
        result: typeof value.result === 'string' ? value.result.length + ' chars' : value.result
      };
    }
    return status;
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

      const token = await this.getStoredToken();
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': `ParadiseSteamLibrary/${app.getVersion()}`,
        'X-API-Key': "RZ7QJgxJHpK4RXbnuVALpBwoIAZ4Mux6"
      };
      
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await axios.post(USER_ACTIVITY_API, userData, {
        timeout: 5000,
        headers
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

      const token = await this.getStoredToken();
      const headers = {
        'Content-Type': 'application/json',
        'User-Agent': `ParadiseSteamLibrary/${app.getVersion()}`,
        'X-API-Key': "RZ7QJgxJHpK4RXbnuVALpBwoIAZ4Mux6"
      };
      
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      await axios.post(USER_ACTIVITY_API, userData, {
        timeout: 3000,
        headers
      });

      console.log('✓ Kullanıcı oturumu sonlandırıldı');
    } catch (error) {
      console.log('✗ Kullanıcı oturumu sonlandırılamadı:', error.message);
    }
  }

  async getActiveUsersCount() {
    try {
      const token = await this.getStoredToken();
      const headers = {
        'User-Agent': `ParadiseSteamLibrary/${app.getVersion()}`,
        'X-API-Key': "RZ7QJgxJHpK4RXbnuVALpBwoIAZ4Mux6"
      };
      
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      const response = await axios.get(`${USER_ACTIVITY_API}/count`, {
        timeout: 5000,
        headers
      });

      return response.data.activeUsers;
    } catch (error) {
      console.log('✗ Aktif kullanıcı sayısı alınamadı:', error.message);
      return 0;
    }
  }

  async checkExternalTools() {
    console.log('Checking external tools availability...');
    
    try {
      const { exec } = require('child_process');
      const util = require('util');
      const execAsync = util.promisify(exec);
      
      await execAsync('7z --version');
      console.log('✓ 7-Zip is available');
    } catch (error) {
      console.log('✗ 7-Zip is not available:', error.message);
    }
    
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

  async checkSteamSetup() {
    try {
      if (!this.config.steamPath) {
        console.log('Steam path not set, will prompt user');
        this.steamSetupStatus = {
          hasSteamPath: false,
          hasHidDll: false,
          directoriesCreated: false,
          steamPath: null
        };
        return;
      }

      if (!await fs.pathExists(this.config.steamPath)) {
        console.log('Steam path does not exist:', this.config.steamPath);
        this.config.steamPath = null;
        await this.saveConfig();
        this.steamSetupStatus = {
          hasSteamPath: false,
          hasHidDll: false,
          directoriesCreated: false,
          steamPath: null
        };
        return;
      }

      const hidDllPath = path.join(this.config.steamPath, 'hid.dll');
      const hasHidDll = await fs.pathExists(hidDllPath);

      const configPath = path.join(this.config.steamPath, 'config');
      const stpluginPath = path.join(configPath, 'stplug-in');
      const depotcachePath = path.join(configPath, 'depotcache');

      let directoriesCreated = false;
      
      if (!await fs.pathExists(configPath)) {
        await fs.ensureDir(configPath);
        directoriesCreated = true;
      }
      
      if (!await fs.pathExists(stpluginPath)) {
        await fs.ensureDir(stpluginPath);
        directoriesCreated = true;
      }
      
      if (!await fs.pathExists(depotcachePath)) {
        await fs.ensureDir(depotcachePath);
        directoriesCreated = true;
      }

      this.steamSetupStatus = {
        hasSteamPath: true,
        hasHidDll: hasHidDll,
        directoriesCreated: directoriesCreated,
        steamPath: this.config.steamPath
      };

      console.log('Steam setup check completed:', this.steamSetupStatus);
    } catch (error) {
      console.error('Error checking Steam setup:', error);
      this.steamSetupStatus = {
        hasSteamPath: false,
        hasHidDll: false,
        directoriesCreated: false,
        steamPath: null
      };
    }
  }

  async init() {
    await this.ensureAppDataDir();
    await this.loadConfig();
    await this.loadGamesCache();
    await this.loadOnlineGamesCache();
    await this.initDiscordRPC();
    await this.checkExternalTools(); // Harici araçları kontrol et
    await this.checkSteamSetup(); // Steam kurulum kontrolü
  }

  sendSteamSetupStatus() {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('steam-setup-status-updated', this.steamSetupStatus);
    }
  }

  async ensureAppDataDir() {
    await fs.ensureDir(this.appDataPath);
  }

  getBrowserHeaders(referer) {
    return {
      'Referer': referer || 'https://online-fix.me',
      'Origin': 'https://online-fix.me',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
      'Connection': 'keep-alive'
    };
  }

  async buildAppIdMap(steamPath) {
    const map = new Map();
    try {
      const steamapps = path.join(steamPath, 'steamapps');
      const files = await fs.readdir(steamapps);
      
      let validGameCount = 0;
      let totalAcfFiles = 0;
      
      console.log(`🔍 Steamapps klasörü taranıyor: ${steamapps}`);
      
      for (const f of files) {
        if (f.startsWith('appmanifest_') && f.endsWith('.acf')) {
          totalAcfFiles++;
          try {
            const content = await fs.readFile(path.join(steamapps, f), 'utf8');
            
            const downloadTypeMatch = content.match(/"DownloadType"\s*"(\d+)"/);
            const appidMatch = content.match(/"appid"\s*"(\d+)"/);
            const installdirMatch = content.match(/"installdir"\s*"([^"]+)"/);
            const nameMatch = content.match(/"name"\s*"([^"]+)"/);
            
            let appId = null;
            if (appidMatch && appidMatch[1]) {
              appId = appidMatch[1];
            }
            
            let gameName = null;
            
            if (nameMatch && nameMatch[1] && nameMatch[1].trim()) {
              gameName = nameMatch[1].trim();
            }
            
            if (!gameName && installdirMatch && installdirMatch[1]) {
              const originalDir = installdirMatch[1];
              gameName = this.formatGameName(originalDir);
            }
            
            if (!gameName && appId) {
              gameName = `Game ${appId}`;
            }
            
            if (appId && installdirMatch && installdirMatch[1]) {
              const isInstalled = downloadTypeMatch && downloadTypeMatch[1] === "1";
              
              if (isInstalled) {
              map.set(installdirMatch[1], {
                appid: appId,
                name: gameName,
                installed: isInstalled
              });
              
              validGameCount++;
                console.log(`✅ ACF işlendi: ${gameName} (${appId}) - ${installdirMatch[1]}`);
              } else {
                console.log(`⏭️ Yüklü olmayan oyun atlandı: ${gameName || 'Unknown'} (${appId})`);
            }
            } else {
              console.log(`⚠️ ACF verisi eksik: ${f} - AppID: ${appId}, InstallDir: ${installdirMatch?.[1]}`);
            }
            
          } catch (e) {
            console.error(`❌ ACF dosyası okunamadı: ${f}`, e);
          }
        }
      }
      
      console.log(`📊 ACF tarama tamamlandı: ${totalAcfFiles} ACF dosyası, ${validGameCount} yüklü oyun`);
      
    } catch (e) {
      console.error('buildAppIdMap hatası:', e);
    }
    return map;
  }
  
  formatGameName(dirName) {
    return dirName
      .replace(/_/g, ' ')           // Alt çizgileri boşluk yap
      .replace(/-/g, ' ')           // Tireleri boşluk yap
      .replace(/\s+/g, ' ')         // Çoklu boşlukları tek boşluk yap
      .replace(/\b\w/g, l => l.toUpperCase()) // Her kelimenin ilk harfini büyük yap
      .trim();
  }

  async hasRepairFix(targetDir) {
    try { 
      return await fs.pathExists(path.join(targetDir, this.repairFixMarkFile)); 
    } catch (e) { 
      return false; 
    }
  }

  async markRepairFixInstalled(targetDir) {
    const markPath = path.join(targetDir, this.repairFixMarkFile);
    const data = { installedAt: new Date().toISOString() };
    await fs.writeJson(markPath, data, { spaces: 2 });
  }

  async unmarkRepairFix(targetDir) {
    try { 
      await fs.remove(path.join(targetDir, this.repairFixMarkFile)); 
    } catch (e) {
    }
  }

  async backupBeforeExtract(targetDir) {
    const backupDir = path.join(targetDir, '._repair_fix_backup');
    await fs.ensureDir(backupDir);
    return;
  }

  async restoreFromBackup(targetDir) {
    const backupDir = path.join(targetDir, '._repair_fix_backup');
    if (await fs.pathExists(backupDir)) {
    }
    return;
  }

  async extractArchiveWithPassword(archivePath, targetDir, password) {
    const seven = `7z x "${archivePath}" -o"${targetDir}" -p"${password}" -y`;
    try {
      await this.execAsync(seven);
      return;
    } catch (e) {
    }
    const winrar = '"C:\\Program Files\\WinRAR\\WinRAR.exe" x -p"' + password + '" -y "' + archivePath + '" "' + targetDir + '\\"';
    try {
      await this.execAsync(winrar);
      return;
    } catch (e) {
    }
    const winrar86 = '"C:\\Program Files (x86)\\WinRAR\\WinRAR.exe" x -p"' + password + '" -y "' + archivePath + '" "' + targetDir + '\\"';
    try {
      await this.execAsync(winrar86);
      return;
    } catch (e) {
    }
    try {
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(targetDir, true);
    } catch (e) {
      throw new Error('Arşiv ayıklama başarısız');
    }
  }

  execAsync(cmd) {
    return new Promise((resolve, reject) => {
      exec(cmd, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve({ stdout, stderr });
      });
    });
  }

  async loadConfig() {
    try {
      if (await fs.pathExists(this.configPath)) {
        try {
          const configContent = await fs.readFile(this.configPath, 'utf8');
          
          if (!configContent || configContent.trim() === '') {
            console.log('Config dosyası boş, yeni config oluşturuluyor...');
            throw new Error('Empty config file');
          }
          
          this.config = JSON.parse(configContent);
          console.log('✅ Config başarıyla yüklendi');
        } catch (parseError) {
          console.error('Config dosyası bozuk, yeni config oluşturuluyor:', parseError.message);
          
          const backupPath = this.configPath + '.backup.' + Date.now();
          await fs.move(this.configPath, backupPath);
          console.log('Bozuk config yedeklendi:', backupPath);
          
          throw new Error('Corrupted config file');
        }
      } else {
        console.log('Config dosyası bulunamadı, yeni config oluşturuluyor...');
        throw new Error('Config file not found');
      }
    } catch (error) {
      console.log('Yeni config oluşturuluyor...');
      
      this.config = {
        steamPath: '',
        theme: 'dark',
        themePreset: 'Dark',
        customTheme: {},
        autoStart: false,
        discordRPC: true,
        animations: true,
        soundEffects: true,
        apiCooldown: 1000,
        maxConcurrentRequests: 5,
        discordInviteAsked: false,
        jwtToken: null,
        userInfo: null,
        lastLogin: null
      };
      
      await this.saveConfig();
      console.log('✅ Yeni config oluşturuldu ve kaydedildi');
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

  async saveJWTToken(token, userInfo) {
    try {
      console.log('saveJWTToken called with token:', token ? 'EXISTS' : 'NULL');
      console.log('User info:', userInfo);
      
      this.config.jwtToken = token;
      this.config.userInfo = userInfo;
      this.config.lastLogin = Date.now();
      
      console.log('Config updated, saving...');
      await this.saveConfig();
      
      console.log('JWT token saved to config successfully');
      console.log('Current config jwtToken:', this.config.jwtToken);
    } catch (error) {
      console.error('Failed to save JWT token:', error);
    }
  }

  async getJWTToken() {
    console.log('getJWTToken called');
    console.log('Current config:', this.config);
    console.log('jwtToken in config:', this.config.jwtToken);
    
    if (!this.config.jwtToken || this.config.jwtToken === null || this.config.jwtToken === undefined || this.config.jwtToken === '' || this.config.jwtToken.trim() === '') {
      console.log('getJWTToken: Token is null/empty, returning null');
      return null;
    }
    
    console.log('getJWTToken: Valid token found, returning token');
    return this.config.jwtToken;
  }

  async getUserInfo() {
    return this.config.userInfo || null;
  }

  async clearJWTToken() {
    try {
      this.config.jwtToken = null;
      this.config.userInfo = null;
      this.config.lastLogin = null;
      await this.saveConfig();
      console.log('JWT token cleared from config');
    } catch (error) {
      console.error('Failed to clear JWT token:', error);
    }
  }

  async isTokenValid() {
    const token = this.config.jwtToken;
    if (!token) return false;
    
    try {
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
      const currentTime = Date.now() / 1000;
      
      if (payload.exp && payload.exp < currentTime) {
        await this.clearJWTToken();
        return false;
      }
      
      return true;
    } catch (error) {
      console.error('Token validation error:', error);
      await this.clearJWTToken();
      return false;
    }
  }

  async loadOnlineGamesCache() { this.onlineGamesCache = { games: [], cached_at: 0 }; }

  async saveOnlineGamesCache() { /* no-op */ }

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

    this.mainWindow.webContents.on('did-finish-load', () => {
      setTimeout(() => {
        this.sendSteamSetupStatus();
      }, 1000); // 1 saniye bekle
    });

    this.mainWindow.on('closed', () => {
      this.mainWindow = null;
    });

    global.steamManager = this;

    this.setupIPC();
  }

  setupIPC() {
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

    ipcMain.handle('get-config', () => {
      return this.config;
    });

    ipcMain.handle('save-config', async (event, newConfig) => {
      this.config = { ...this.config, ...newConfig };
      await this.saveConfig();
      return this.config;
    });

    ipcMain.handle('save-jwt-token', async (event, token, userInfo) => {
      await this.saveJWTToken(token, userInfo);
      return { success: true };
    });

    ipcMain.handle('get-jwt-token', async () => {
      return await this.getJWTToken();
    });

    ipcMain.handle('get-user-info', async () => {
      return await this.getUserInfo();
    });

    ipcMain.handle('clear-jwt-token', async () => {
      await this.clearJWTToken();
      return { success: true };
    });

    ipcMain.handle('is-token-valid', async () => {
      return await this.isTokenValid();
    });

    ipcMain.handle('save-notification-sound', async (event, fileData) => {
      try {
        const soundsDir = path.join(this.appDataPath, 'sounds');
        await fs.ensureDir(soundsDir);
        
        const fileName = `notification_sound_${Date.now()}.${fileData.name.split('.').pop()}`;
        const filePath = path.join(soundsDir, fileName);
        
        await fs.writeFile(filePath, Buffer.from(fileData.buffer));
        
        return {
          name: fileData.name,
          path: filePath,
          size: fileData.size
        };
      } catch (error) {
        console.error('Ses dosyası kaydetme hatası:', error);
        throw error;
      }
    });

    ipcMain.handle('delete-notification-sound', async (event, soundPath) => {
      try {
        if (await fs.pathExists(soundPath)) {
          await fs.unlink(soundPath);
        }
      } catch (error) {
        console.error('Ses dosyası silme hatası:', error);
      }
    });

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
          await this.checkSteamSetup(); // Re-check setup after path change
          return steamPath;
        } else {
          throw new Error('steam.exe seçilen klasörde bulunamadı');
        }
      }
      return null;
    });

    ipcMain.handle('get-steam-setup-status', async () => {
      try {
        if (this.config && this.config.steamPath) {
          console.log('Config\'deki Steam yolu kullanılıyor:', this.config.steamPath);
          
          await this.checkSteamSetup();
          
          return this.steamSetupStatus;
        } else {
          console.log('Config\'de Steam yolu yok');
          return {
            hasSteamPath: false,
            hasHidDll: false,
            directoriesCreated: false,
            steamPath: null
          };
        }
      } catch (error) {
        console.error('❌ Steam setup status hatası:', error);
        return {
          hasSteamPath: false,
          hasHidDll: false,
          directoriesCreated: false,
          steamPath: null
        };
      }
    });

    ipcMain.handle('close-program', () => {
      process.exit(0);
    });

    ipcMain.handle('download-hid-dll', async (event, token) => {
      try {
        if (!this.config.steamPath) {
          return { success: false, error: 'Steam yolu ayarlanmamış' };
        }

        // Token kontrolü - parametre olarak gelen token'ı kullan
        console.log('🔍 Gelen token var mı:', !!token);
        console.log('🔍 Gelen token değeri:', token ? token.substring(0, 50) + '...' : 'YOK');
        
        if (!token) {
          console.log('❌ Token parametresi bulunamadı');
          return { success: false, error: 'Giriş yapılmamış - Token bulunamadı' };
        }

        const downloadUrl = 'https://api.muhammetdag.com/steamlib/hid.php';
        const hidDllPath = path.join(this.config.steamPath, 'hid.dll');
        
        console.log('Downloading hid.dll from:', downloadUrl);
        console.log('Target path:', hidDllPath);
        console.log('Using Bearer token for authentication');
        
        const response = await axios({
          method: 'GET',
          url: downloadUrl,
          responseType: 'stream',
          timeout: 30000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Authorization': `Bearer ${token}`
          }
        });
        
        const writer = fs.createWriteStream(hidDllPath);
        response.data.pipe(writer);
        
        return new Promise((resolve, reject) => {
          writer.on('finish', async () => {
            console.log('hid.dll successfully downloaded to:', hidDllPath);
            
            await this.checkSteamSetup();
            
            this.sendSteamSetupStatus();
            
            resolve({ success: true, message: 'hid.dll başarıyla indirildi' });
          });
          
          writer.on('error', (error) => {
            console.error('Error writing hid.dll:', error);
            reject({ success: false, error: 'Dosya yazma hatası: ' + error.message });
          });
        });
        
      } catch (error) {
        console.error('Error downloading hid.dll:', error);
        return { success: false, error: 'İndirme hatası: ' + error.message };
      }
    });

    ipcMain.handle('open-in-chrome', async (event, url) => {
      try {
        return await this.openUrlInChrome(url);
      } catch (error) {
        console.error('Failed to open in Chrome:', error);
        try { 
          await shell.openExternal(url); 
        } catch (e) {
        }
        return false;
      }
    });

    ipcMain.handle('get-app-version', () => {
      try {
        return app.getVersion();
      } catch (e) {
        return null;
      }
    });

    ipcMain.handle('fetch-steam-games', async (event, category = 'featured', page = 1) => {
      return await this.fetchSteamGames(category, page);
    });

    ipcMain.handle('fetch-game-details', async (event, appId, selectedLang = 'turkish') => {
      return await this.fetchGameDetails(appId, selectedLang);
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

    ipcMain.handle('open-external', async (event, url) => {
      shell.openExternal(url);
    });

    ipcMain.handle('select-directory', async (event, title) => {
      const result = await dialog.showOpenDialog(this.mainWindow, {
        properties: ['openDirectory'],
        title: title || 'Klasör Seçin'
      });
      return result;
    });

    ipcMain.handle('check-bypass-status', async (event, appId) => {
      return await this.checkBypassStatus(appId);
    });

    ipcMain.handle('download-and-install-bypass', async (event, options) => {
      return await this.downloadAndInstallBypass(options);
    });

    ipcMain.handle('remove-bypass', async (event, appId) => {
      return await this.removeBypass(appId);
    });

    ipcMain.handle('scan-steam-common', async () => {
      try {
        const steamPath = this.config.steamPath;
        if (!steamPath) throw new Error('Steam path not configured');
        
        const appIdByInstallDir = await this.buildAppIdMap(steamPath);
        
        const processedAppIds = new Set();
        const processedNames = new Set();
        const uniqueResults = [];
        
        for (const [installDir, gameInfo] of appIdByInstallDir) {
          try {
            if (!gameInfo.installed) {
              console.log(`⏭️ Yüklü olmayan oyun atlandı: ${gameInfo.name} (${gameInfo.appid})`);
              continue;
            }
            
            if (processedAppIds.has(gameInfo.appid)) {
              console.log(`❌ Duplicate AppID engellendi: ${gameInfo.appid} - ${gameInfo.name}`);
              continue;
            }
            
            if (processedNames.has(gameInfo.name)) {
              console.log(`❌ Duplicate oyun adı engellendi: ${gameInfo.name}`);
              continue;
            }
            
            const commonDir = path.join(steamPath, 'steamapps', 'common');
            const fullPath = path.join(commonDir, installDir);
            
            if (!await fs.pathExists(fullPath)) {
              console.log(`⚠️ Klasör bulunamadı: ${installDir} - ${gameInfo.name}`);
              continue;
            }
            
            processedAppIds.add(gameInfo.appid);
            processedNames.add(gameInfo.name);
            
            const installedFix = await this.hasRepairFix(fullPath);
            
            uniqueResults.push({ 
              folderName: installDir, 
              gameName: gameInfo.name, 
              appid: gameInfo.appid, 
              fullPath, 
              installedFix
            });
            
            console.log(`✅ Oyun eklendi: ${gameInfo.name} (${gameInfo.appid}) - ${installDir}`);
            
          } catch (e) { 
            console.error(`❌ Oyun işlenirken hata: ${installDir}`, e);
            continue;
          }
        }
        
        console.log(`✅ scan-steam-common: ${uniqueResults.length} unique oyun bulundu (ACF'den direkt)`);
        return uniqueResults;
      } catch (e) {
        console.error('scan-steam-common error:', e);
        return [];
      }
    });

    ipcMain.handle('scan-acf-only', async () => {
      try {
        const steamPath = this.config.steamPath;
        if (!steamPath) throw new Error('Steam path not configured');
        
        console.log(`🔍 Sadece ACF dosyalarından oyun bilgileri alınıyor...`);
        
        const appIdByInstallDir = await this.buildAppIdMap(steamPath);
        
        const processedAppIds = new Set();
        const processedNames = new Set();
        const uniqueResults = [];
        
        for (const [installDir, gameInfo] of appIdByInstallDir) {
          try {
            if (processedAppIds.has(gameInfo.appid)) {
              console.log(`❌ Duplicate AppID engellendi: ${gameInfo.appid} - ${gameInfo.name}`);
              continue;
            }
            
            if (processedNames.has(gameInfo.name)) {
              console.log(`❌ Duplicate oyun adı engellendi: ${gameInfo.name}`);
              continue;
            }
            
            processedAppIds.add(gameInfo.appid);
            processedNames.add(gameInfo.name);
            
            const commonDir = path.join(steamPath, 'steamapps', 'common');
            const fullPath = path.join(commonDir, installDir);
            
            let installedFix = false;
            if (await fs.pathExists(fullPath)) {
              installedFix = await this.hasRepairFix(fullPath);
            }
            
            uniqueResults.push({ 
              folderName: installDir, 
              gameName: gameInfo.name, 
              appid: gameInfo.appid, 
              fullPath: await fs.pathExists(fullPath) ? fullPath : null, 
              installedFix,
              hasFolder: await fs.pathExists(fullPath)
            });
            
            console.log(`✅ ACF oyunu eklendi: ${gameInfo.name} (${gameInfo.appid}) - ${installDir} [Klasör: ${await fs.pathExists(fullPath) ? 'Var' : 'Yok'}]`);
            
      } catch (e) {
            console.error(`❌ ACF oyunu işlenirken hata: ${installDir}`, e);
            continue;
          }
        }
        
        console.log(`✅ scan-acf-only: ${uniqueResults.length} unique oyun bulundu (sadece ACF'den)`);
        return uniqueResults;
      } catch (e) {
        console.error('scan-acf-only error:', e);
        return [];
      }
    });

    ipcMain.handle('check-repair-fix-available', async (event, folderName) => {
      try {
        console.log(`🔍 Tek oyun check: ${folderName}`);
        return await this.checkRepairFixAvailable(folderName);
      } catch (e) {
        console.error('check-repair-fix-available error:', e);
        return false;
      }
    });

    ipcMain.handle('list-repair-fix-files', async (event, folderName) => {
      try {
        console.log(`📋 Tek oyun list: ${folderName}`);
        return await this.listRepairFixFiles(folderName);
      } catch (e) {
        console.error('list-repair-fix-files error:', e);
        return '';
      }
    });

    ipcMain.handle('download-and-install-repair-fix', async (event, payload) => {
      const { folderName, targetDir, fileName } = payload || {};
      if (!folderName || !targetDir || !fileName) throw new Error('Invalid payload');
      try {
        const tmpArchive = path.join(tmp, `${Date.now()}_${fileName}`);
        
        const response = await this.downloadRepairFixFile(folderName, fileName);
        
        await new Promise((resolve, reject) => {
          const writer = fs.createWriteStream(tmpArchive);
          response.pipe(writer);
          writer.on('finish', resolve);
          writer.on('error', reject);
          response.on('error', reject);
        });

        const stats = await fs.stat(tmpArchive);
        if (stats.size === 0) {
          throw new Error('Downloaded file is empty');
        }

        console.log(`File downloaded successfully: ${tmpArchive} (${stats.size} bytes)`);

        const backupDir = path.join(targetDir, '._repair_fix_backup');
        await fs.ensureDir(backupDir);

        const beforeSnap = await this.snapshotDirFiles(targetDir);
        console.log(`📸 Kurulum öncesi snapshot alındı: ${beforeSnap.size} dosya`);
        const changedFiles = [];

        try {
          console.log(`🔍 Arşiv içeriği okunuyor: ${tmpArchive}`);
          const archiveEntries = await this.getArchiveEntries(tmpArchive);
          console.log(`📦 Arşivden ${archiveEntries.length} dosya/klasör bulundu:`, archiveEntries);
          
          if (archiveEntries.length === 0) {
            console.log(`⚠️ Arşiv içeriği okunamadı, alternatif yöntem kullanılıyor...`);

        await this.extractArchiveWithPassword(tmpArchive, targetDir, 'online-fix.me');
            
            const afterSnap = await this.snapshotDirFiles(targetDir);
            const changedFilesFromDiff = this.computeDiff(beforeSnap, afterSnap);
            
            console.log(`📋 Diff ile tespit edilen dosyalar: ${changedFilesFromDiff.length}`, changedFilesFromDiff);
            
            changedFiles.push(...changedFilesFromDiff);
            
          } else {
            for (const entry of archiveEntries) {
              if (!entry.isDirectory) {
                const targetPath = path.join(targetDir, entry.entryName);
                
                if (await fs.pathExists(targetPath)) {
                  const backupPath = path.join(backupDir, entry.entryName);
                  await fs.ensureDir(path.dirname(backupPath));
                  await fs.copy(targetPath, backupPath);
                  console.log(`✅ Yedeklendi: ${entry.entryName}`);
                }
                
                changedFiles.push(entry.entryName);
                console.log(`📝 Dosya listeye eklendi: ${entry.entryName}`);
              }
            }
            
            await this.extractArchiveWithPassword(tmpArchive, targetDir, 'online-fix.me');
          }
          
          console.log(`📋 Toplam ${changedFiles.length} dosya işlenecek`);
          
        } catch (extractError) {
          console.error('❌ Arşiv işleme hatası:', extractError);
          throw new Error(`Arşiv çıkarma başarısız: ${extractError.message}`);
        }

        try { 
          await fs.remove(tmpArchive); 
        } catch (e) {
        }

        await this.writeRepairFixManifest(targetDir, changedFiles, tmpArchive);
        
        const backupInfo = {
          originalFiles: changedFiles,
          backupDir: backupDir,
          installedAt: new Date().toISOString(),
          archiveName: fileName
        };
        
        const backupInfoPath = path.join(targetDir, '._repair_fix_backup_info.json');
        await fs.writeJson(backupInfoPath, backupInfo, { spaces: 2 });

        await this.markRepairFixInstalled(targetDir);
        console.log(`✅ Online fix kurulumu tamamlandı. ${changedFiles.length} dosya işlendi.`);
        return true;
      } catch (error) {
        console.error('download-and-install-repair-fix error:', error);
        throw error;
      }
    });

    ipcMain.handle('uninstall-repair-fix', async (event, payload) => {
      const { targetDir } = payload || {};
      if (!targetDir) throw new Error('Invalid payload');
      try {
        const manifest = await this.readRepairFixManifest(targetDir);
        const backupInfoPath = path.join(targetDir, '._repair_fix_backup_info.json');
        
        if (manifest && Array.isArray(manifest.files)) {
          console.log(`🔄 Online fix kaldırılıyor: ${manifest.files.length} dosya işlenecek`);
          
          for (const rel of manifest.files) {
            const full = path.join(targetDir, rel);
            try { 
            await fs.remove(full); 
              console.log(`🗑️ Silindi: ${rel}`);
          } catch (e) {
              console.warn(`⚠️ Dosya silinemedi: ${rel}`, e.message);
          }
          }
          
          const uniqueDirs = Array.from(new Set(manifest.files.map(f => path.dirname(f)).filter(d => d && d !== '.')));
          for (const d of uniqueDirs) {
            const fullDir = path.join(targetDir, d);
            try {
              const exists = await fs.pathExists(fullDir);
              if (exists) {
                const files = await fs.readdir(fullDir);
                if (files.length === 0) {
                  await fs.remove(fullDir);
                  console.log(`🗑️ Boş klasör silindi: ${d}`);
                }
              }
            } catch (e) {
              console.warn(`⚠️ Klasör kontrol hatası: ${d}`, e.message);
            }
          }
        }
        
        if (await fs.pathExists(backupInfoPath)) {
          try {
            const backupInfo = await fs.readJson(backupInfoPath);
            console.log(`📦 Backup bulundu: ${backupInfo.originalFiles.length} dosya geri yüklenecek`);
            
            if (backupInfo.backupDir && backupInfo.originalFiles && backupInfo.originalFiles.length > 0) {
              for (const fileName of backupInfo.originalFiles) {
                try {
                  const backupPath = path.join(backupInfo.backupDir, fileName);
                  const targetPath = path.join(targetDir, fileName);
                  
                  if (await fs.pathExists(backupPath)) {
                    await fs.ensureDir(path.dirname(targetPath));
                    await fs.copy(backupPath, targetPath);
                    console.log(`✅ Geri yüklendi: ${fileName}`);
                  }
                } catch (restoreError) {
                  console.error(`❌ Dosya geri yüklenemedi: ${fileName}`, restoreError.message);
                }
              }
              
              try {
                await fs.remove(backupInfo.backupDir);
                await fs.remove(backupInfoPath);
                console.log(`🧹 Backup klasörü temizlendi`);
              } catch (cleanupError) {
                console.error(`⚠️ Backup temizleme hatası:`, cleanupError.message);
              }
            }
          } catch (backupError) {
            console.error(`❌ Backup bilgisi okunamadı:`, backupError.message);
          }
        }
        
        await this.unmarkRepairFix(targetDir);
        console.log(`✅ Online fix başarıyla kaldırıldı`);
        return true;
      } catch (error) {
        console.error('uninstall-repair-fix error:', error);
        throw error;
      }
    });

    ipcMain.handle('clear-repair-fix-cache', async (event, folderName) => {
      this.clearRepairFixCache(folderName);
      return { success: true };
    });

    ipcMain.handle('get-repair-fix-cache-status', async (event) => {
      return this.getRepairFixCacheStatus();
    });

    ipcMain.handle('install-manual-game', async (event, gameData) => {
      try {
        if (!this.config.steamPath) {
          throw new Error('Steam path not configured');
        }

        const { filePath } = gameData;
        
        if (!filePath || !await fs.pathExists(filePath)) {
          throw new Error('Seçilen dosya bulunamadı');
        }

        const stats = await fs.stat(filePath);
        if (stats.size < 1000) {
          throw new Error('Dosya çok küçük veya bozuk');
        }

        const buffer = await fs.readFile(filePath);
        const isZip = buffer.slice(0, 4).toString('hex') === '504b0304';
        
        if (!isZip) {
          throw new Error('Geçersiz ZIP dosyası');
        }

        const gameInfo = await this.extractManualGameFiles(filePath);
        
        return { success: true, message: 'Oyun başarıyla kuruldu', gameInfo };
      } catch (error) {
        console.error('Failed to install manual game:', error);
        throw error;
      }
    });

    ipcMain.handle('get-temp-dir', async () => {
      return this.appDataPath;
    });

    ipcMain.handle('write-temp-file', async (event, filePath, buffer) => {
      try {
        await fs.writeFile(filePath, buffer);
        return { success: true };
      } catch (error) {
        console.error('Failed to write temp file:', error);
        throw error;
      }
    });

    ipcMain.handle('test-zip-extraction', async (event, zipPath, targetDir) => {
      try {
        console.log('=== TESTING ZIP EXTRACTION ===');
        console.log('ZIP Path:', zipPath);
        console.log('Target Directory:', targetDir);
        
        if (!await fs.pathExists(zipPath)) {
          throw new Error(`ZIP dosyası bulunamadı: ${zipPath}`);
        }
        
        const stats = await fs.stat(zipPath);
        console.log('ZIP file size:', stats.size, 'bytes');
        
        await fs.ensureDir(targetDir);
        console.log('Target directory created/verified');
        
        await this.extractZipFile(zipPath, targetDir);
        
        console.log('=== ZIP EXTRACTION TEST SUCCESSFUL ===');
        return { success: true, message: 'ZIP extraction test successful' };
      } catch (error) {
        console.log('=== ZIP EXTRACTION TEST FAILED ===');
        console.log('Error:', error.message);
        return { success: false, error: error.message };
      }
    });

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

    if (game.name && this.isDenuvoProbable(game.name)) {
      tags.push({ name: 'Denuvo', color: '#FF9800' });
    }

    if (game.name && this.isEAGame(game.name)) {
      tags.push({ name: 'EA', color: '#FF5722' });
    }

    if (this.isOnlineGame(game)) {
      tags.push({ name: 'Online', color: '#2196F3' });
    }

    return tags;
  }

  isDenuvoProbable(gameName) {
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
      const cachedResults = Object.values(this.gamesCache).filter(game =>
        game.name.toLowerCase().includes(query.toLowerCase())
      );

      if (cachedResults.length > 0) {
        return cachedResults;
      }

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

  async fetchGameDetails(appId, selectedLang = 'turkish') {
    try {
      console.log('Main: fetchGameDetails çağrıldı, appId:', appId, 'selectedLang:', selectedLang);
      
      const cachedData = await this.getCachedGameData(appId);
      if (cachedData) {
        console.log('Main: Cache hit, oyun verisi cache\'den alındı:', cachedData.name);
        return cachedData;
      }
      
      console.log('Main: Cache miss, Steam API\'den çekiliyor:', appId, 'dil:', selectedLang);
      
      try {
        const langMap = {
          'tr': { cc: 'TR', l: 'turkish' },
          'en': { cc: 'US', l: 'english' },
          'de': { cc: 'DE', l: 'german' },
          'fr': { cc: 'FR', l: 'french' },
          'es': { cc: 'ES', l: 'spanish' },
          'it': { cc: 'IT', l: 'italian' },
          'ru': { cc: 'RU', l: 'russian' }
        };
        
        const langConfig = langMap[selectedLang] || langMap['tr'];
        const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${langConfig.cc}&l=${langConfig.l}`;
        
        console.log('Main: Steam API URL:', url);
        
        const response = await axios.get(url, { 
          timeout: 15000,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
          }
        });
        
        console.log('Main: Steam API yanıtı:', {
          status: response.status,
          hasData: !!response.data,
          appIdExists: !!(response.data && response.data[appId]),
          success: response.data && response.data[appId] ? response.data[appId].success : false,
          dataKeys: response.data && response.data[appId] ? Object.keys(response.data[appId]) : 'no data'
        });
        
        if (response.data && response.data[appId] && response.data[appId].success) {
          const gameData = response.data[appId].data;
          console.log('Main: Game data anahtarları:', Object.keys(gameData));
          
          const formattedGame = {
            appid: appId,
            steam_appid: appId, // steam_appid alanını da ekle
            name: gameData.name || `Game ${appId}`,
            type: gameData.type || 'game',
            developers: gameData.developers || [],
            publishers: gameData.publishers || [],
            release_date: gameData.release_date || { date: 'Bilinmiyor' },
            price_overview: gameData.price_overview || null,
            is_free: gameData.is_free || false,
            short_description: gameData.short_description || '',
            about_the_game: gameData.about_the_game || '',
            detailed_description: gameData.detailed_description || '',
            screenshots: gameData.screenshots || [],
            movies: gameData.movies || [],
            genres: gameData.genres || [],
            recommendations: gameData.recommendations || { total: 0 },
            header_image: gameData.header_image || '',
            background: gameData.background || '',
            platforms: gameData.platforms || {},
            categories: gameData.categories || [],
            metacritic: gameData.metacritic || null,
            dlc: gameData.dlc || [],
            price: gameData.price_overview ? gameData.price_overview.final : 0,
            discount_percent: gameData.price_overview ? gameData.price_overview.discount_percent : 0
          };
          
          await this.setCachedGameData(appId, formattedGame);
          console.log('Main: Oyun verisi Steam API\'den alındı ve cache\'e kaydedildi:', formattedGame.name);
          
          return formattedGame;
        } else {
          console.error('Main: Steam API\'den oyun verisi alınamadı:', appId);
          console.log('Main: API yanıt detayları:', {
            responseData: response.data,
            appIdData: response.data ? response.data[appId] : 'no appId data',
            success: response.data && response.data[appId] ? response.data[appId].success : 'no success field'
          });
          
          const simpleGame = {
            appid: appId,
            steam_appid: appId,
            name: `Game ${appId}`,
            type: 'game',
            developers: [],
            publishers: [],
            release_date: { date: 'Bilinmiyor' },
            price_overview: null,
            is_free: false,
            short_description: 'Steam API\'den veri alınamadı',
            about_the_game: 'Steam API\'den veri alınamadı',
            detailed_description: 'Steam API\'den veri alınamadı',
            screenshots: [],
            movies: [],
            genres: [],
            recommendations: { total: 0 },
            header_image: '',
            background: '',
            platforms: {},
            categories: [],
            metacritic: null,
            dlc: [],
            price: 0,
            discount_percent: 0
          };
          
          console.log('Main: Basit oyun verisi döndürülüyor:', simpleGame.name);
          return simpleGame;
        }
        
      } catch (apiError) {
        console.error('Main: Steam API hatası:', apiError.message);
        console.log('Main: API hata detayları:', {
          code: apiError.code,
          status: apiError.response?.status,
          statusText: apiError.response?.statusText,
          data: apiError.response?.data
        });
        
        // 403 hatası için özel cache
        if (apiError.response?.status === 403) {
          const errorGame = {
            appid: appId,
            steam_appid: appId,
            name: `Game ${appId}`,
            type: 'game',
            developers: [],
            publishers: [],
            release_date: { date: 'Bilinmiyor' },
            price_overview: null,
            is_free: false,
            short_description: 'Steam API 403 hatası - erişim reddedildi',
            about_the_game: 'Steam API 403 hatası - erişim reddedildi',
            detailed_description: 'Steam API 403 hatası - erişim reddedildi',
            screenshots: [],
            movies: [],
            genres: [],
            recommendations: { total: 0 },
            header_image: '',
            background: '',
            platforms: {},
            categories: [],
            metacritic: null,
            dlc: [],
            price: 0,
            discount_percent: 0,
            isError: true,
            errorType: '403_FORBIDDEN',
            errorMessage: apiError.message
          };
          
          await this.setCachedGameData(appId, errorGame);
          console.log(`🚫 403 hatası cache'e kaydedildi: ${appId}`);
          
          return errorGame;
        }
        
        const fallbackGame = {
          appid: appId,
          steam_appid: appId,
          name: `Game ${appId}`,
          type: 'game',
          developers: [],
          publishers: [],
          release_date: { date: 'Bilinmiyor' },
          price_overview: null,
          is_free: false,
          short_description: 'Steam API hatası nedeniyle veri alınamadı',
          about_the_game: 'Steam API hatası nedeniyle veri alınamadı',
          detailed_description: 'Steam API hatası nedeniyle veri alınamadı',
          screenshots: [],
          movies: [],
          genres: [],
          recommendations: { total: 0 },
          header_image: '',
          background: '',
          platforms: {},
          categories: [],
          metacritic: null,
          dlc: [],
          price: 0,
          discount_percent: 0
        };
        
        await this.setCachedGameData(appId, fallbackGame);
        console.log('Main: Fallback oyun verisi cache\'e kaydedildi:', appId);
        
        return fallbackGame;
      }
      
    } catch (error) {
      console.error('Main: fetchGameDetails genel hatası:', error.message);
      console.error('Main: Hata stack:', error.stack);
      console.error('Main: Hata detayları:', {
        name: error.name,
        message: error.message,
        code: error.code,
        response: error.response ? {
          status: error.response.status,
          statusText: error.response.statusText,
          data: error.response.data
        } : 'No response'
      });
      return null;
    }
  }

  async addGameToLibrary(appId, includeDLCs = []) {
    try {
      console.log('Main: addGameToLibrary çağrıldı, appId:', appId, 'includeDLCs:', includeDLCs);
      console.log('Main: Steam path:', this.config.steamPath);
      
      if (!this.config.steamPath) {
        console.error('Main: Steam path bulunamadı!');
        throw new Error('Steam path not configured');
      }

      console.log('Main: Steam path bulundu, oyun kontrol ediliyor...');

      const gameUrl = `https://api.muhammetdag.com/steamlib/game/gamev2.php?steamid=${appId}`;
      console.log('Main: Oyun URL:', gameUrl);
      
      const token = await this.getStoredToken();
      if (!token) {
        throw new Error('JWT token bulunamadı');
      }

      const headers = {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'Paradise-Steam-Library/1.0'
      };
      
      try {
        const checkUrl = `${gameUrl}&check=1`;
        console.log('Main: Oyun kontrol URL:', checkUrl);
        
        const checkResponse = await axios.get(checkUrl, { 
          headers,
          timeout: 10000 
        });
        console.log('Main: Oyun mevcut, status:', checkResponse.status);
        
      } catch (checkError) {
        if (checkError.response && checkError.response.status === 404) {
          console.log('Main: Oyun bulunamadı (404) - check request');
          return { success: false, message: 'GAME_NOT_FOUND' };
        }
        console.log('Main: Check request hatası, devam ediliyor:', checkError.message);
      }
      
      console.log('Main: Oyun bulundu, dosyası indiriliyor...');
      
      const response = await axios.get(gameUrl, { 
        headers,
        responseType: 'stream',
        timeout: 30000
      });
      
      console.log('Main: API yanıtı alındı, status:', response.status);
      
      const tempZipPath = path.join(this.appDataPath, `${appId}.zip`);
      console.log('Main: Geçici ZIP dosyası yolu:', tempZipPath);
      
      const writer = fs.createWriteStream(tempZipPath);
      
      response.data.pipe(writer);
      
      return new Promise((resolve, reject) => {
        writer.on('finish', async () => {
          try {
            console.log('Main: ZIP dosyası indirildi, çıkarılıyor...');
            await this.extractGameFiles(tempZipPath, appId);
            
            console.log('Main: Oyun dosyaları çıkarıldı');
            
            if (includeDLCs.length > 0) {
              console.log('Main: DLC\'ler ekleniyor:', includeDLCs);
              await this.addDLCsToGame(appId, includeDLCs);
            }
            
            console.log('Main: Geçici dosyalar temizleniyor...');
            await fs.remove(tempZipPath);
            
            console.log('Main: Oyun başarıyla eklendi!');
            
            await this.logSuccessAction({
              action: 'add_game_to_library',
              appId,
              includeDLCs,
              timestamp: new Date().toISOString(),
              success: true,
              message: 'Game added successfully'
            });
            
            resolve({ success: true, message: 'Game added successfully' });
          } catch (error) {
            console.error('Main: Oyun ekleme hatası:', error);
            
            await this.logFailAction({
              action: 'add_game_to_library',
              appId,
              includeDLCs,
              timestamp: new Date().toISOString(),
              error: error.message,
              stack: error.stack
            });
            
            reject(error);
          }
        });
        
        writer.on('error', (error) => {
          console.error('Main: Dosya yazma hatası:', error);
          
          this.logFailAction({
            action: 'add_game_to_library',
            appId,
            includeDLCs,
            timestamp: new Date().toISOString(),
            error: error.message,
            stack: error.stack
          });
          
          reject(error);
        });
      });
    } catch (error) {
      console.error('Main: addGameToLibrary genel hatası:', error);
      
      await this.logFailAction({
        action: 'add_game_to_library',
        appId,
        includeDLCs,
        timestamp: new Date().toISOString(),
        error: error.message,
        stack: error.stack,
        responseStatus: error.response?.status,
        responseData: error.response?.data
      });
      
      if (error.response && error.response.status === 404) {
        console.log('Main: Oyun bulunamadı (404)');
        throw new Error('GAME_NOT_FOUND');
      }
      
      if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
        console.log('Main: API bağlantı hatası');
        throw new Error('API_CONNECTION_ERROR');
      }
      
      throw error;
    }
  }

  async extractGameFiles(zipPath, appId) {
    console.log('Main: extractGameFiles başladı, zipPath:', zipPath, 'appId:', appId);
    
    const stpluginDir = path.join(this.config.steamPath, 'config', 'stplug-in');
    const depotcacheDir = path.join(this.config.steamPath, 'config', 'depotcache');
    
    console.log('Main: stpluginDir:', stpluginDir);
    console.log('Main: depotcacheDir:', depotcacheDir);
    
    try {
      if (!await fs.pathExists(stpluginDir)) {
        console.log('Main: stplug-in klasörü yok, oluşturuluyor...');
        await fs.ensureDir(stpluginDir);
      }
      if (!await fs.pathExists(depotcacheDir)) {
        console.log('Main: depotcache klasörü yok, oluşturuluyor...');
        await fs.ensureDir(depotcacheDir);
      }
    } catch (error) {
      console.error('Main: Klasör oluşturma hatası:', error);
      throw error;
    }
    
    return new Promise((resolve, reject) => {
      console.log('Main: ZIP dosyası açılıyor...');
      
      yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
        if (err) {
          console.error('Main: ZIP açma hatası:', err);
          return reject(err);
        }
        
        console.log('Main: ZIP dosyası başarıyla açıldı');
        zipfile.readEntry();
        
        zipfile.on('entry', (entry) => {
          console.log('Main: ZIP entry işleniyor:', entry.fileName);
          
          if (/\/$/.test(entry.fileName)) {
            console.log('Main: Klasör entry, atlanıyor');
            zipfile.readEntry();
          } else {
            zipfile.openReadStream(entry, (err, readStream) => {
              if (err) {
                console.error('Main: ZIP stream açma hatası:', err);
                return reject(err);
              }
              
              let targetPath;
              if (entry.fileName.endsWith('.lua')) {
                targetPath = path.join(stpluginDir, path.basename(entry.fileName));
                console.log('Main: LUA dosyası:', targetPath);
              } else if (entry.fileName.endsWith('.manifest')) {
                targetPath = path.join(depotcacheDir, path.basename(entry.fileName));
                console.log('Main: Manifest dosyası:', targetPath);
              } else {
                console.log('Main: Bilinmeyen dosya türü, atlanıyor:', entry.fileName);
                zipfile.readEntry();
                return;
              }
              
              console.log('Main: Dosya yazılıyor:', targetPath);
              const writeStream = fs.createWriteStream(targetPath);
              readStream.pipe(writeStream);
              
              writeStream.on('close', () => {
                console.log('Main: Dosya yazıldı:', targetPath);
                zipfile.readEntry();
              });
              
              writeStream.on('error', (error) => {
                console.error('Main: Dosya yazma hatası:', error);
                reject(error);
              });
            });
          }
        });
        
        zipfile.on('end', () => {
          console.log('Main: ZIP dosyası işleme tamamlandı');
          resolve();
        });
        
        zipfile.on('error', (error) => {
          console.error('Main: ZIP işleme hatası:', error);
          reject(error);
        });
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

  async getGameInfoFromSteam(appId) {
    try {
      // Önce cache'den kontrol et
      const cachedData = await this.getCachedGameData(appId);
      if (cachedData) {
        if (cachedData.isError) {
          console.log(`🚫 Cache'den 403 hatası alındı (getGameInfoFromSteam): ${appId}`);
          // 403 hatası alan oyunlar için alternatif Steam API endpoint'lerini dene
          return await this.tryAlternativeSteamAPIs(appId);
        }
        return {
          name: cachedData.name || `Game ${appId}`,
          installDir: cachedData.name || 'Unknown'
        };
      }
      
      const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&l=turkish`;
      const response = await axios.get(url, { timeout: 10000 });
      
      if (response.data && response.data[appId] && response.data[appId].success) {
        const gameData = response.data[appId].data;
        const gameInfo = {
          name: gameData.name || `Game ${appId}`,
          installDir: gameData.name || 'Unknown'
        };
        
        // Başarılı veriyi cache'e kaydet
        const formattedGame = {
          appid: appId,
          steam_appid: appId,
          name: gameData.name || `Game ${appId}`,
          type: 'game',
          developers: gameData.developers || [],
          publishers: gameData.publishers || [],
          release_date: gameData.release_date || { date: 'Bilinmiyor' },
          price_overview: gameData.price_overview || null,
          is_free: gameData.is_free || false,
          short_description: gameData.short_description || '',
          about_the_game: gameData.about_the_game || '',
          detailed_description: gameData.detailed_description || '',
          screenshots: gameData.screenshots || [],
          movies: gameData.movies || [],
          genres: gameData.genres || [],
          recommendations: gameData.recommendations || { total: 0 },
          header_image: gameData.header_image || '',
          background: gameData.background || '',
          platforms: gameData.platforms || {},
          categories: gameData.categories || [],
          metacritic: gameData.metacritic || null,
          dlc: gameData.dlc || [],
          price: gameData.price_overview?.final || 0,
          discount_percent: gameData.price_overview?.discount_percent || 0
        };
        
        await this.setCachedGameData(appId, formattedGame);
        console.log(`✅ Steam API verisi cache'e kaydedildi (getGameInfoFromSteam): ${appId} -> ${gameData.name}`);
        
        return gameInfo;
      }
      
      return null;
    } catch (error) {
      console.warn(`Steam API hatası (${appId}):`, error.message);
      
      // 403 hatası için cache
      if (error.response?.status === 403) {
        const errorGame = {
          appid: appId,
          steam_appid: appId,
          name: `Game ${appId}`,
          type: 'game',
          developers: [],
          publishers: [],
          release_date: { date: 'Bilinmiyor' },
          price_overview: null,
          is_free: false,
          short_description: 'Steam API 403 hatası - erişim reddedildi',
          about_the_game: 'Steam API 403 hatası - erişim reddedildi',
          detailed_description: 'Steam API 403 hatası - erişim reddedildi',
          screenshots: [],
          movies: [],
          genres: [],
          recommendations: { total: 0 },
          header_image: '',
          background: '',
          platforms: {},
          categories: [],
          metacritic: null,
          dlc: [],
          price: 0,
          discount_percent: 0,
          isError: true,
          errorType: '403_FORBIDDEN',
          errorMessage: error.message
        };
        
        await this.setCachedGameData(appId, errorGame);
        console.log(`🚫 403 hatası cache'e kaydedildi (getGameInfoFromSteam): ${appId}`);
        
        // 403 hatası alan oyunlar için alternatif Steam API endpoint'lerini dene
        return await this.tryAlternativeSteamAPIs(appId);
      }
      
      return null;
    }
  }

  async tryAlternativeSteamAPIs(appId) {
    console.log(`🔄 ${appId} için alternatif Steam API endpoint'leri deneniyor...`);
    
    // 1. Steam Store Search API
    try {
      const searchUrl = `https://store.steampowered.com/api/storeSearch/?term=${appId}&l=english&cc=US`;
      const searchResponse = await axios.get(searchUrl, { timeout: 10000 });
      
      if (searchResponse.data && searchResponse.data.items && searchResponse.data.items.length > 0) {
        const game = searchResponse.data.items.find(item => item.id == appId);
        if (game) {
          console.log(`✅ Steam Store Search API'den oyun adı alındı: ${appId} -> ${game.name}`);
          
          // Cache'i güncelle
          const updatedGame = {
            appid: appId,
            steam_appid: appId,
            name: game.name,
            type: 'game',
            developers: game.developers || [],
            publishers: game.publishers || [],
            release_date: game.release_date || { date: 'Bilinmiyor' },
            price_overview: game.price_overview || null,
            is_free: game.is_free || false,
            short_description: game.short_description || '',
            about_the_game: game.about_the_game || '',
            detailed_description: game.detailed_description || '',
            screenshots: game.screenshots || [],
            movies: game.movies || [],
            genres: game.genres || [],
            recommendations: game.recommendations || { total: 0 },
            header_image: game.header_image || '',
            background: game.background || '',
            platforms: game.platforms || {},
            categories: game.categories || [],
            metacritic: game.metacritic || null,
            dlc: game.dlc || [],
            price: game.price_overview?.final || 0,
            discount_percent: game.price_overview?.discount_percent || 0
          };
          
          await this.setCachedGameData(appId, updatedGame);
          
          return {
            name: game.name,
            installDir: game.name || 'Unknown'
          };
        }
      }
    } catch (searchError) {
      console.log(`❌ Steam Store Search API hatası (${appId}):`, searchError.message);
    }
    
    // 2. Steam Community API
    try {
      const communityUrl = `https://steamcommunity.com/app/${appId}/`;
      const communityResponse = await axios.get(communityUrl, { timeout: 10000 });
      
      // HTML'den oyun adını çıkarmaya çalış
      const html = communityResponse.data;
      
      // Farklı HTML pattern'lerini dene
      let gameName = null;
      
      // Pattern 1: <title> tag'inden
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      if (titleMatch && titleMatch[1]) {
        gameName = titleMatch[1]
          .replace(/^Steam Community\s*::\s*/i, '')
          .replace(/\s*::\s*Steam Community$/i, '')
          .replace(/\s*on Steam$/i, '')
          .replace(/\s*-\s*Steam Community$/i, '')
          .replace(/^Steam Community\s*-\s*/i, '')
          .trim();
      }
      
      // Pattern 2: og:title meta tag'inden
      if (!gameName) {
        const ogTitleMatch = html.match(/<meta property="og:title" content="([^"]+)"/);
        if (ogTitleMatch && ogTitleMatch[1]) {
          gameName = ogTitleMatch[1]
            .replace(/^Steam Community\s*::\s*/i, '')
            .replace(/\s*::\s*Steam Community$/i, '')
            .replace(/\s*on Steam$/i, '')
            .replace(/\s*-\s*Steam Community$/i, '')
            .replace(/^Steam Community\s*-\s*/i, '')
            .trim();
        }
      }
      
      // Pattern 3: h1 tag'inden
      if (!gameName) {
        const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
        if (h1Match && h1Match[1]) {
          gameName = h1Match[1].trim();
        }
      }
      
      // Pattern 4: apphub_AppName class'ından
      if (!gameName) {
        const appNameMatch = html.match(/class="apphub_AppName"[^>]*>([^<]+)</);
        if (appNameMatch && appNameMatch[1]) {
          gameName = appNameMatch[1].trim();
        }
      }
      
      if (gameName && gameName !== 'Steam Community' && gameName.length > 0) {
        console.log(`✅ Steam Community API'den oyun adı alındı: ${appId} -> ${gameName}`);
        
        // Cache'i güncelle
        const updatedGame = {
                appid: appId,
          steam_appid: appId,
                name: gameName,
          type: 'game',
          developers: [],
          publishers: [],
          release_date: { date: 'Bilinmiyor' },
          price_overview: null,
          is_free: false,
          short_description: gameName,
          about_the_game: gameName,
          detailed_description: gameName,
          screenshots: [],
          movies: [],
          genres: [],
          recommendations: { total: 0 },
          header_image: '',
          background: '',
          platforms: {},
          categories: [],
          metacritic: null,
          dlc: [],
          price: 0,
          discount_percent: 0
        };
        
        await this.setCachedGameData(appId, updatedGame);
        
        return {
          name: gameName,
          installDir: gameName || 'Unknown'
        };
            } else {
        console.log(`❌ Steam Community API'den oyun adı alınamadı (${appId})`);
      }
    } catch (communityError) {
      console.log(`❌ Steam Community API hatası (${appId}):`, communityError.message);
    }
    
    // 3. SteamDB API (üçüncü parti)
    try {
      const steamdbUrl = `https://steamdb.info/app/${appId}/`;
      const steamdbResponse = await axios.get(steamdbUrl, { timeout: 10000 });
      
      const html = steamdbResponse.data;
      let gameName = null;
      
      // Pattern 1: <title> tag'inden
      const titleMatch = html.match(/<title>([^<]+)<\/title>/);
      if (titleMatch && titleMatch[1]) {
        gameName = titleMatch[1]
          .replace(' · SteamDB', '')
          .replace(' - SteamDB', '')
          .replace('SteamDB :: ', '')
          .trim();
      }
      
      // Pattern 2: h1 tag'inden
      if (!gameName) {
        const h1Match = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
        if (h1Match && h1Match[1]) {
          gameName = h1Match[1].trim();
        }
      }
      
      // Pattern 3: app-name class'ından
      if (!gameName) {
        const appNameMatch = html.match(/class="app-name"[^>]*>([^<]+)</);
        if (appNameMatch && appNameMatch[1]) {
          gameName = appNameMatch[1].trim();
        }
      }
      
      if (gameName && gameName !== 'SteamDB' && gameName.length > 0) {
        console.log(`✅ SteamDB API'den oyun adı alındı: ${appId} -> ${gameName}`);
        
        // Cache'i güncelle
        const updatedGame = {
              appid: appId,
          steam_appid: appId,
          name: gameName,
          type: 'game',
          developers: [],
          publishers: [],
          release_date: { date: 'Bilinmiyor' },
          price_overview: null,
          is_free: false,
          short_description: gameName,
          about_the_game: gameName,
          detailed_description: gameName,
          screenshots: [],
          movies: [],
          genres: [],
          recommendations: { total: 0 },
          header_image: '',
          background: '',
          platforms: {},
          categories: [],
          metacritic: null,
          dlc: [],
          price: 0,
          discount_percent: 0
        };
        
        await this.setCachedGameData(appId, updatedGame);
        
        return {
          name: gameName,
          installDir: gameName || 'Unknown'
        };
      } else {
        console.log(`❌ SteamDB API'den oyun adı alınamadı (${appId})`);
      }
    } catch (steamdbError) {
      console.log(`❌ SteamDB API hatası (${appId}):`, steamdbError.message);
    }
    
    console.log(`❌ ${appId} için hiçbir alternatif API'den oyun adı alınamadı`);
    return null;
  }

  async getLibraryGames() {
    try {
      console.log('Main: getLibraryGames çağrıldı (stplug-in tabanlı)');
      
      if (!this.config.steamPath) {
        console.log('Main: Steam path bulunamadı');
        return [];
      }
      
      const stpluginDir = path.join(this.config.steamPath, 'config', 'stplug-in');
      
      if (!await fs.pathExists(stpluginDir)) {
        console.log('Main: stplug-in klasörü bulunamadı');
        return [];
      }
      
      console.log(`Main: stplug-in klasörü bulundu: ${stpluginDir}`);
      
      const luaFiles = await fs.readdir(stpluginDir);
      const luaFilesFiltered = luaFiles.filter(file => file.endsWith('.lua'));
      
      console.log(`Main: ${luaFilesFiltered.length} .lua dosyası bulundu`);
      
      const games = [];
      const processedAppIds = new Set();
      
      for (const luaFile of luaFilesFiltered) {
        try {
          const fileName = luaFile.replace('.lua', '');
          
          if (/^\d+$/.test(fileName)) {
            const appId = parseInt(fileName);
            
            if (processedAppIds.has(appId)) {
              console.log(`❌ Duplicate AppID engellendi: ${appId}`);
              continue;
            }
            
            processedAppIds.add(appId);
            
            try {
              const gameInfo = await this.getGameInfoFromSteam(appId);
              
              if (gameInfo && gameInfo.name) {
              games.push({
                appid: appId,
                  name: gameInfo.name,
                  installDir: gameInfo.installDir || 'Unknown',
                  hasFolder: true,
                  source: 'stplug-in'
                });
                
                console.log(`✅ stplug-in oyunu eklendi: ${gameInfo.name} (${appId})`);
        } else {
              games.push({
                appid: appId,
                  name: `Game ${appId}`,
                  installDir: 'Unknown',
                  hasFolder: true,
                  source: 'stplug-in'
                });
                
                console.log(`⚠️ stplug-in oyunu eklendi (API bilgisi yok): ${appId}`);
              }
            } catch (steamError) {
              console.warn(`⚠️ Steam API hatası (${appId}):`, steamError.message);
              
            games.push({
              appid: appId,
                name: `Game ${appId}`,
                installDir: 'Unknown',
                hasFolder: true,
                source: 'stplug-in'
              });
            }
          } else {
            console.log(`⏭️ Harf içeren dosya atlandı: ${luaFile}`);
          }
        } catch (fileError) {
          console.error(`❌ Lua dosyası işlenirken hata: ${luaFile}`, fileError);
          continue;
        }
      }
      
      console.log(`Main: ${games.length} stplug-in oyunu bulundu`);
      return games;
      
    } catch (error) {
      console.error('Main: getLibraryGames hatası:', error);
      return [];
    }
  }

  async restartSteam() {
    try {
      if (!this.config.steamPath) {
        throw new Error('Steam path not configured');
      }

      const steamExe = path.join(this.config.steamPath, 'steam.exe');
      
      exec('taskkill /F /IM steam.exe', (error) => {
        if (error) {
          console.log('Steam was not running or failed to close');
        }
        
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
          if (appId) {
            try {
              const gameDetails = await this.fetchGameDetails(appId, 'turkish');
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
    return new Promise(async (resolve, reject) => {
      console.log('🔧 Extracting ZIP archive:', zipPath);
      console.log('🎯 Target directory:', targetDir);
      
      try {
        await fs.ensureDir(targetDir);
        console.log('✅ Target directory created/verified:', targetDir);
        
        try {
          console.log('🔄 Trying AdmZip extraction...');
          const AdmZip = require('adm-zip');
          
          if (!fs.existsSync(zipPath)) {
            throw new Error('ZIP dosyası bulunamadı');
          }
          
          const zip = new AdmZip(zipPath);
          
          const zipEntries = zip.getEntries();
          if (zipEntries.length === 0) {
            throw new Error('ZIP dosyası boş');
          }
          
          console.log(`📁 ZIP içeriği: ${zipEntries.length} dosya/dizin`);
          
          zip.extractAllTo(targetDir, true);
          console.log('✅ AdmZip extraction successful');
          resolve();
          return;
        } catch (admZipError) {
          console.log('❌ AdmZip failed:', admZipError.message);
          console.log('🔍 AdmZip error details:', {
            message: admZipError.message,
            stack: admZipError.stack,
            zipPath,
            targetDir
          });
        }
        
        try {
          console.log('🔄 Trying 7-Zip extraction...');
          
          try {
            await new Promise((resolveCheck, rejectCheck) => {
              exec('7z', (error, stdout, stderr) => {
                if (error && error.code !== 0) {
                  rejectCheck(new Error('7-Zip bulunamadı'));
                } else {
                  resolveCheck();
                }
              });
            });
          } catch (checkError) {
            console.log('⚠️ 7-Zip bulunamadı, atlanıyor...');
            throw new Error('7-Zip bulunamadı');
          }
          
          const command = `7z x "${zipPath}" -o"${targetDir}" -y`;
          console.log('📝 7-Zip command:', command);
          
          await new Promise((resolve7z, reject7z) => {
          exec(command, (error, stdout, stderr) => {
            if (error) {
                console.log('❌ 7-Zip failed:', error.message);
                console.log('📝 7-Zip stderr:', stderr);
                console.log('📝 7-Zip stdout:', stdout);
                reject7z(error);
              } else {
                console.log('✅ 7-Zip extraction successful');
                console.log('📝 7-Zip output:', stdout);
                resolve7z();
              }
            });
          });
          
          resolve();
          return;
        } catch (error) {
          console.log('❌ 7-Zip extraction failed:', error.message);
        }
        
        try {
          console.log('🔄 Trying WinRAR extraction...');
          
          const winrarPath = 'C:\\Program Files\\WinRAR\\WinRAR.exe';
          if (!fs.existsSync(winrarPath)) {
            console.log('⚠️ WinRAR bulunamadı, atlanıyor...');
            throw new Error('WinRAR bulunamadı');
          }
          
          const winrarCommand = `"${winrarPath}" x -y "${zipPath}" "${targetDir}\\"`;
          console.log('📝 WinRAR command:', winrarCommand);
          
          await new Promise((resolveWinRAR, rejectWinRAR) => {
            exec(winrarCommand, (error, stdout, stderr) => {
              if (error) {
                console.log('❌ WinRAR failed:', error.message);
                console.log('📝 WinRAR stderr:', stderr);
                console.log('📝 WinRAR stdout:', stdout);
                rejectWinRAR(error);
              } else {
                console.log('✅ WinRAR extraction successful');
                console.log('📝 WinRAR output:', stdout);
                resolveWinRAR();
              }
            });
          });
          
          resolve();
          return;
        } catch (error) {
          console.log('❌ WinRAR extraction failed:', error.message);
        }
        
        try {
          console.log('🔄 Trying WinRAR (x86) extraction...');
          
          const winrarAltPath = 'C:\\Program Files (x86)\\WinRAR\\WinRAR.exe';
          if (!fs.existsSync(winrarAltPath)) {
            console.log('⚠️ WinRAR (x86) bulunamadı, atlanıyor...');
            throw new Error('WinRAR (x86) bulunamadı');
          }
          
          const winrarAltCommand = `"${winrarAltPath}" x -y "${zipPath}" "${targetDir}\\"`;
          console.log('📝 WinRAR (x86) command:', winrarAltCommand);
          
          await new Promise((resolveWinRARx86, rejectWinRARx86) => {
            exec(winrarAltCommand, (error, stdout, stderr) => {
              if (error) {
                console.log('❌ WinRAR (x86) failed:', error.message);
                console.log('📝 WinRAR (x86) stderr:', stderr);
                console.log('📝 WinRAR (x86) stdout:', stdout);
                rejectWinRARx86(error);
              } else {
                console.log('✅ WinRAR (x86) extraction successful');
                console.log('📝 WinRAR (x86) output:', stdout);
                resolveWinRARx86();
              }
            });
          });
          
                              resolve();
          return;
        } catch (error) {
          console.log('❌ WinRAR (x86) extraction failed:', error.message);
        }
        
        try {
          console.log('🔄 Trying Node.js yauzl extraction...');
          
          try {
            require.resolve('yauzl');
          } catch (resolveError) {
            console.log('⚠️ yauzl kütüphanesi bulunamadı, atlanıyor...');
            throw new Error('yauzl kütüphanesi bulunamadı');
          }
          
          await this.extractWithNodeJS(zipPath, targetDir);
          console.log('✅ Node.js yauzl extraction successful');
          resolve();
          return;
        } catch (error) {
          console.log('❌ Node.js yauzl extraction failed:', error.message);
          console.log('🔍 yauzl error details:', {
            message: error.message,
            stack: error.stack
          });
        }
        
        try {
          console.log('🔄 Trying simple file copy as last resort...');
          
          const targetZipPath = path.join(targetDir, path.basename(zipPath));
          await fs.copy(zipPath, targetZipPath);
          
          console.log('✅ Simple file copy successful');
          console.log('⚠️ ZIP dosyası çıkarılmadı, sadece kopyalandı');
          console.log('📁 Hedef konum:', targetZipPath);
          
          resolve();
          return;
        } catch (copyError) {
          console.log('❌ Simple file copy failed:', copyError.message);
        }
        
        try {
          console.log('🔄 Trying manual ZIP extraction as last resort...');
          
          const AdmZip = require('adm-zip');
          const zip = new AdmZip(zipPath);
          
          await fs.emptyDir(targetDir);
          
          zip.extractAllTo(targetDir, true);
          
          console.log('✅ Manual ZIP extraction successful');
          resolve();
          return;
        } catch (manualError) {
          console.log('❌ Manual ZIP extraction failed:', manualError.message);
        }
        
        console.log('❌ All extraction methods failed');
        
        const errorSummary = {
          'AdmZip': 'Node.js kütüphanesi başarısız',
          '7-Zip': 'Sistem komut satırı aracı bulunamadı',
          'WinRAR': 'Program Files dizininde bulunamadı',
          'WinRAR (x86)': 'Program Files (x86) dizininde bulunamadı',
          'Node.js yauzl': 'Yauzl kütüphanesi başarısız',
          'Simple Copy': 'Dosya kopyalama başarısız',
          'Manual ZIP': 'Manuel ZIP çıkarma başarısız'
        };
        
        reject(new Error(`ZIP extraction failed - Detaylar: ${JSON.stringify(errorSummary)}`));
        
      } catch (error) {
        console.log('❌ ZIP extraction failed:', error.message);
        reject(new Error(`ZIP extraction failed: ${error.message}`));
      }
    });
  }

  async extractRarFile(rarPath, targetDir) {
    return new Promise(async (resolve, reject) => {
      console.log('🔧 Extracting RAR archive:', rarPath);
      console.log('🎯 Target directory:', targetDir);
      
      try {
        await fs.ensureDir(targetDir);
        console.log('✅ Target directory created/verified:', targetDir);
        
        try {
          console.log('🔄 Trying WinRAR extraction...');
          const winrarCommand = `"C:\\Program Files\\WinRAR\\WinRAR.exe" x -y "${rarPath}" "${targetDir}\\"`;
          console.log('📝 WinRAR command:', winrarCommand);
          
          await new Promise((resolveWinRAR, rejectWinRAR) => {
            exec(winrarCommand, (error, stdout, stderr) => {
              if (error) {
                console.log('❌ WinRAR failed:', error.message);
                rejectWinRAR(error);
                        } else {
                console.log('✅ WinRAR extraction successful');
                resolveWinRAR();
              }
            });
          });
          
                          resolve();
          return;
        } catch (error) {
          console.log('❌ WinRAR extraction failed');
        }
        
        try {
          console.log('🔄 Trying WinRAR (x86) extraction...');
          const winrarAltCommand = `"C:\\Program Files (x86)\\WinRAR\\WinRAR.exe" x -y "${rarPath}" "${targetDir}\\"`;
          console.log('📝 WinRAR (x86) command:', winrarAltCommand);
          
          await new Promise((resolveWinRARx86, rejectWinRARx86) => {
            exec(winrarAltCommand, (error, stdout, stderr) => {
              if (error) {
                console.log('❌ WinRAR (x86) failed:', error.message);
                rejectWinRARx86(error);
              } else {
                console.log('✅ WinRAR (x86) extraction successful');
                resolveWinRARx86();
              }
            });
          });
          
          resolve();
          return;
        } catch (error) {
          console.log('❌ WinRAR (x86) extraction failed');
        }
        
        try {
          console.log('🔄 Trying 7-Zip RAR extraction...');
          const command = `7z x "${rarPath}" -o"${targetDir}" -y`;
          console.log('📝 7-Zip command:', command);
          
          await new Promise((resolve7z, reject7z) => {
            exec(command, (error, stdout, stderr) => {
              if (error) {
                console.log('❌ 7-Zip RAR failed:', error.message);
                reject7z(error);
                    } else {
                console.log('✅ 7-Zip RAR extraction successful');
                resolve7z();
              }
            });
          });
          
                      resolve();
          return;
        } catch (error) {
          console.log('❌ 7-Zip RAR extraction failed');
        }
        
        console.log('❌ All RAR extraction methods failed');
        reject(new Error('RAR extraction failed - Tüm yöntemler başarısız oldu'));
        
      } catch (error) {
        console.log('❌ RAR extraction failed:', error.message);
        reject(new Error(`RAR extraction failed: ${error.message}`));
      }
    });
  }

  async extract7zFile(sevenZipPath, targetDir) {
    return new Promise(async (resolve, reject) => {
      console.log('🔧 Extracting 7Z archive:', sevenZipPath);
      console.log('🎯 Target directory:', targetDir);
      
      try {
        await fs.ensureDir(targetDir);
        console.log('✅ Target directory created/verified:', targetDir);
        
        try {
          console.log('🔄 Trying 7-Zip extraction...');
          const command = `7z x "${sevenZipPath}" -o"${targetDir}" -y`;
          console.log('📝 7-Zip command:', command);
          
          await new Promise((resolve7z, reject7z) => {
            exec(command, (error, stdout, stderr) => {
              if (error) {
                console.log('❌ 7-Zip failed:', error.message);
                reject7z(error);
                } else {
                console.log('✅ 7-Zip extraction successful');
                resolve7z();
              }
            });
          });
          
                  resolve();
          return;
        } catch (error) {
          console.log('❌ 7-Zip extraction failed');
        }
        
        try {
          console.log('🔄 Trying WinRAR 7Z extraction...');
          const winrarCommand = `"C:\\Program Files\\WinRAR\\WinRAR.exe" x -y "${sevenZipPath}" "${targetDir}\\"`;
          console.log('📝 WinRAR command:', winrarCommand);
          
          await new Promise((resolveWinRAR, rejectWinRAR) => {
            exec(winrarCommand, (error, stdout, stderr) => {
              if (error) {
                console.log('❌ WinRAR 7Z failed:', error.message);
                rejectWinRAR(error);
              } else {
                console.log('✅ WinRAR 7Z extraction successful');
                resolveWinRAR();
              }
            });
          });
          
          resolve();
          return;
        } catch (error) {
          console.log('❌ WinRAR 7Z extraction failed');
        }
        
        console.log('❌ All 7Z extraction methods failed');
        reject(new Error('7Z extraction failed - Tüm yöntemler başarısız oldu'));
        
      } catch (error) {
        console.log('❌ 7Z extraction failed:', error.message);
        reject(new Error(`7Z extraction failed: ${error.message}`));
      }
    });
  }

  async extractTarFile(tarPath, targetDir) {
    return new Promise(async (resolve, reject) => {
      console.log('🔧 Extracting TAR archive:', tarPath);
      console.log('🎯 Target directory:', targetDir);
      
      try {
        await fs.ensureDir(targetDir);
        console.log('✅ Target directory created/verified:', targetDir);
        
        try {
          console.log('🔄 Trying 7-Zip TAR extraction...');
          const command = `7z x "${tarPath}" -o"${targetDir}" -y`;
          console.log('📝 7-Zip command:', command);
          
          await new Promise((resolve7z, reject7z) => {
            exec(command, (error, stdout, stderr) => {
              if (error) {
                console.log('❌ 7-Zip TAR failed:', error.message);
                reject7z(error);
            } else {
                console.log('✅ 7-Zip TAR extraction successful');
                resolve7z();
              }
            });
          });
          
              resolve();
          return;
        } catch (error) {
          console.log('❌ 7-Zip TAR extraction failed');
        }
        
        try {
          console.log('🔄 Trying Node.js TAR extraction...');
          const tar = require('tar');
          await tar.extract({
            file: tarPath,
            cwd: targetDir
          });
          console.log('✅ Node.js TAR extraction successful');
          resolve();
          return;
        } catch (error) {
          console.log('❌ Node.js TAR extraction failed:', error.message);
        }
        
        console.log('❌ All TAR extraction methods failed');
        reject(new Error('TAR extraction failed - Tüm yöntemler başarısız oldu'));
        
      } catch (error) {
        console.log('❌ TAR extraction failed:', error.message);
        reject(new Error(`TAR extraction failed: ${error.message}`));
      }
    });
  }

  async extractWithNodeJS(zipPath, targetDir) {
    return new Promise((resolve, reject) => {
      console.log('Trying Node.js extraction for:', zipPath);
      
      try {
        
        yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
          if (err) {
            console.log('yauzl failed:', err.message);
            reject(new Error(`Node.js extraction failed: ${err.message}`));
            return;
          }
          
          zipfile.readEntry();
          
          zipfile.on('entry', (entry) => {
            if (entry.fileName.endsWith('/')) {
              const dirPath = path.join(targetDir, entry.fileName);
              fs.ensureDir(dirPath).then(() => {
                zipfile.readEntry();
              }).catch(err => {
                console.log('Failed to create directory:', dirPath, err.message);
                zipfile.readEntry();
              });
            } else {
              const filePath = path.join(targetDir, entry.fileName);
              const dirPath = path.dirname(filePath);
              
              fs.ensureDir(dirPath).then(() => {
                zipfile.openReadStream(entry, (err, readStream) => {
                  if (err) {
                    console.log('Failed to open read stream:', err.message);
                    zipfile.readEntry();
                    return;
                  }
                  
                  const writeStream = fs.createWriteStream(filePath);
                  
                  readStream.pipe(writeStream);
                  
                  writeStream.on('finish', () => {
                    console.log('File extracted:', filePath);
                    zipfile.readEntry();
                  });
                  
                  writeStream.on('error', (err) => {
                    console.log('Write stream error:', err.message);
                    zipfile.readEntry();
                  });
                });
              }).catch(err => {
                console.log('Failed to create directory:', dirPath, err.message);
                zipfile.readEntry();
              });
            }
          });
          
          zipfile.on('end', () => {
            console.log('Node.js extraction completed successfully');
            resolve();
          });
          
          zipfile.on('error', (err) => {
            console.log('Node.js extraction error:', err.message);
            reject(new Error(`Node.js extraction error: ${err.message}`));
          });
        });
      } catch (error) {
        console.log('Node.js extraction failed:', error.message);
        reject(new Error(`Node.js extraction failed: ${error.message}`));
      }
    });
  }

  async checkBypassStatus(appId) {
    try {
      const appDataDir = path.join(process.env.APPDATA, 'Paradise-Steam-Library', 'bypass');
      const configFile = path.join(appDataDir, `${appId}.json`);
      
      if (await fs.pathExists(configFile)) {
        const config = await fs.readJSON(configFile);
        return { installed: true, config };
      }
      
      return { installed: false };
    } catch (error) {
      console.error('Bypass status kontrolü hatası:', error);
      return { installed: false };
    }
  }

  async downloadAndInstallBypass(options) {
    const { appid, fileName, targetDir, token } = options;
    
    try {
      const steamId = String(appid);
      
      console.log(`🚀 Bypass kurulumu başlatılıyor...`);
      console.log(`📁 Oyun: ${fileName} (SteamID: ${steamId})`);
      console.log(`🎯 Hedef dizin: ${targetDir}`);
      
      if (!token) {
        throw new Error('Discord token bulunamadı!');
      }
      
      const downloadUrl = `https://api.muhammetdag.com/steamlib/bypass/bypass.php?steamid=${steamId}`;
      console.log(`🌐 API URL: ${downloadUrl}`);
      console.log(`🔑 Token: ${token.substring(0, 20)}...`);
      
      console.log(`📥 Dosya indiriliyor...`);
      const response = await fetch(downloadUrl, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`,
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        }
      });
      
      if (!response.ok) {
        throw new Error(`API hatası: ${response.status}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      console.log(`✅ Dosya indirildi: ${buffer.length} bytes`);
      
      const tempDir = path.join(process.env.TEMP, 'paradise-bypass');
      await fs.ensureDir(tempDir);
      const tempFile = path.join(tempDir, `${fileName}.zip`);
      
      await fs.writeFile(tempFile, buffer);
      console.log(`📁 Geçici dosya kaydedildi: ${tempFile}`);
      
      console.log(`🔄 ZIP dosyası çıkarılıyor...`);
      
      const backupDir = path.join(process.env.APPDATA, 'Paradise-Steam-Library', 'bypass', 'backups', steamId);
      await fs.ensureDir(backupDir);
      
      const changedFiles = [];
      
      try {
        const AdmZip = require('adm-zip');
        const zip = new AdmZip(tempFile);
        const entries = zip.getEntries();
        
        console.log(`📦 ZIP içeriği: ${entries.length} dosya/dizin`);
        
              for (const entry of entries) {
                if (!entry.isDirectory) {
                  const targetPath = path.join(targetDir, entry.entryName);
                  
                  if (await fs.pathExists(targetPath)) {
                    const backupPath = path.join(backupDir, entry.entryName);
                    await fs.ensureDir(path.dirname(backupPath));
                    await fs.copy(targetPath, backupPath);
                    console.log(`💾 Yedek alındı: ${entry.entryName}`);
                  }
                  
                  changedFiles.push(entry.entryName);
                  console.log(`📝 Dosya listeye eklendi: ${entry.entryName}`);
                }
              }
        
        await this.extractZipFile(tempFile, targetDir);
        console.log(`✅ ZIP dosyası çıkarıldı`);
        
      } catch (extractError) {
        console.log(`❌ ZIP çıkarma hatası:`, extractError.message);
        throw new Error(`ZIP çıkarma başarısız: ${extractError.message}`);
      }
      
      const config = {
        appid: steamId,
        fileName: fileName,
        installedAt: new Date().toISOString(),
        targetDir: targetDir,
        backupDir: backupDir,
        changedFiles: changedFiles
      };
      
      await this.saveBypassConfig(steamId, config);
      
      try {
        await fs.remove(tempFile);
        console.log(`🧹 Geçici dosya temizlendi`);
      } catch (cleanupError) {
        console.log(`⚠️ Geçici dosya temizlenemedi:`, cleanupError.message);
      }
      
      console.log(`✅ Bypass kurulumu tamamlandı!`);
      return { success: true, message: 'Bypass başarıyla kuruldu', config };
      
    } catch (error) {
      console.error(`❌ Bypass kurulum hatası:`, error);
      throw error;
    }
  }

  async removeBypass(appId) {
    try {
      console.log(`🚮 Bypass kaldırılıyor: ${appId}`);
      
      const appDataDir = path.join(process.env.APPDATA, 'Paradise-Steam-Library', 'bypass');
      const configFile = path.join(appDataDir, `${appId}.json`);
      
      if (await fs.pathExists(configFile)) {
        const config = await fs.readJSON(configFile);
        console.log(`📁 Config bulundu:`, config);
        
                  if (config.changedFiles && config.changedFiles.length > 0) {
                    console.log(`🗑️ ${config.changedFiles.length} dosya siliniyor...`);
                    console.log(`📁 Silinecek dosyalar:`, config.changedFiles);
                    
                    for (const fileName of config.changedFiles) {
                      try {
                        const targetPath = path.join(config.targetDir, fileName);
                        if (await fs.pathExists(targetPath)) {
                          await fs.remove(targetPath);
                          console.log(`✅ Dosya silindi: ${fileName}`);
                        } else {
                          console.log(`⚠️ Dosya bulunamadı (zaten silinmiş olabilir): ${fileName}`);
                        }
                      } catch (deleteError) {
                        console.error(`❌ Dosya silinemedi: ${fileName}`, deleteError);
                      }
                    }
                  } else {
                    console.log(`⚠️ changedFiles listesi boş veya bulunamadı`);
                  }
        
                  if (config.backupDir && config.changedFiles && config.changedFiles.length > 0) {
                    console.log(`🔄 Yedeklenen dosyalar geri yükleniyor...`);
                    console.log(`📁 Geri yüklenecek dosyalar:`, config.changedFiles);
                    
                    for (const fileName of config.changedFiles) {
                      try {
                        const backupPath = path.join(config.backupDir, fileName);
                        const targetPath = path.join(config.targetDir, fileName);
                        
                        if (await fs.pathExists(backupPath)) {
                          await fs.ensureDir(path.dirname(targetPath));
                          await fs.copy(backupPath, targetPath);
                          console.log(`✅ Dosya geri yüklendi: ${fileName}`);
                        } else {
                          console.log(`⚠️ Yedek dosya bulunamadı: ${fileName}`);
                        }
                      } catch (restoreError) {
                        console.error(`❌ Dosya geri yüklenemedi: ${fileName}`, restoreError);
                      }
                    }
                    
                    try {
                      await fs.remove(config.backupDir);
                      console.log(`🧹 Yedek klasörü temizlendi: ${config.backupDir}`);
                    } catch (cleanupError) {
                      console.error(`⚠️ Yedek klasörü temizlenemedi:`, cleanupError.message);
                    }
                  } else {
                    console.log(`⚠️ Yedekleme bilgileri eksik veya bulunamadı`);
                  }
        
        await fs.remove(configFile);
        console.log(`🗑️ Config dosyası silindi: ${configFile}`);
      }
      
      console.log(`✅ Bypass başarıyla kaldırıldı: ${appId}`);
      return {
        success: true,
        message: 'Bypass başarıyla kaldırıldı'
      };
      
    } catch (error) {
      console.error('❌ Bypass kaldırma hatası:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  async saveBypassConfig(appId, config) {
    try {
      const appDataDir = path.join(process.env.APPDATA, 'Paradise-Steam-Library', 'bypass');
      await fs.ensureDir(appDataDir);
      
      const configFile = path.join(appDataDir, `${appId}.json`);
      await fs.writeJSON(configFile, config, { spaces: 2 });
      
      console.log(`Bypass config kaydedildi: ${configFile}`);
    } catch (error) {
      console.error('Bypass config kaydetme hatası:', error);
      throw error;
    }
  }

  async logSuccessAction(logData, isCheckRequest = false) {
    if (isCheckRequest) {
      console.log('🔍 Check request - loglama atlandı');
      return;
    }
    
    try {
      const logDir = path.join(this.appDataPath, 'logs');
      await fs.ensureDir(logDir);
      
      const logFile = path.join(logDir, 'success_user.json');
      let logs = [];
      
      if (await fs.pathExists(logFile)) {
        try {
          logs = await fs.readJSON(logFile);
        } catch (readError) {
          console.warn('Log dosyası okunamadı, yeni dosya oluşturuluyor:', readError.message);
        }
      }
      
      logs.push({
        ...logData,
        user: this.config.discord?.username || 'Unknown',
        discord_id: this.config.discord?.id || 'Unknown',
        timestamp: new Date().toISOString()
      });
      
      await fs.writeJSON(logFile, logs, { spaces: 2 });
      console.log('✅ Başarılı işlem logu kaydedildi');
      
    } catch (error) {
      console.error('❌ Başarılı işlem logu kaydedilemedi:', error.message);
    }
  }

  async logFailAction(logData, isCheckRequest = false) {
    if (isCheckRequest) {
      console.log('🔍 Check request - loglama atlandı');
      return;
    }
    
    try {
      const logDir = path.join(this.appDataPath, 'logs');
      await fs.ensureDir(logDir);
      
      const logFile = path.join(logDir, 'fail_log.json');
      let logs = [];
      
      if (await fs.pathExists(logFile)) {
        try {
          logs = await fs.readJSON(logFile);
        } catch (readError) {
          console.warn('Log dosyası okunamadı, yeni dosya oluşturuluyor:', readError.message);
        }
      }
      
      logs.push({
        ...logData,
        user: this.config.discord?.username || 'Unknown',
        discord_id: this.config.discord?.id || 'Unknown',
        timestamp: new Date().toISOString()
      });
      
      await fs.writeJSON(logFile, logs, { spaces: 2 });
      console.log('❌ Hata logu kaydedildi');
      
    } catch (error) {
      console.error('❌ Hata logu kaydedilemedi:', error.message);
    }
  }
}

app.whenReady().then(async () => {
  const manager = new SteamLibraryManager();
  global.steamManager = manager;
  await manager.createWindow();
  
  await manager.startUserSession();
});

app.on('window-all-closed', async () => {
  if (global.steamManager) {
    await global.steamManager.endUserSession();
  }
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async () => {
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