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


class SteamLibraryManager {
  constructor() {
    this.mainWindow = null;
    this.appDataPath = path.join(os.homedir(), 'AppData', 'Local', 'paradisedev');
    this.configPath = path.join(this.appDataPath, 'config.json');
    this.gamesDataPath = path.join(this.appDataPath, 'games.json');
    this.config = {};
    this.gamesCache = {};
    this.discordRPC = null;

    this.init(); // Asenkron başlatıcı
  }

  async init() {
    await this.ensureAppDataDir();
    await this.loadConfig();
    await this.loadGamesCache();
    await this.initDiscordRPC();
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
          maxConcurrentRequests: 5
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

  createWindow() {
    this.mainWindow = new BrowserWindow({
      width: 1400,
      height: 900,
      minWidth: 1200,
      minHeight: 700,
      frame: false,
      titleBarStyle: 'hidden',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        webSecurity: false
      },
      show: false,
      backgroundColor: '#0a0a0a',
      icon: path.join(__dirname, 'pdlogo.ico') 
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

    // Online oyun dosyası indirme - YENİ SİSTEM
    ipcMain.handle('download-online-file', async (event, appId) => {
      try {
        console.log('Downloading online file for appId:', appId);
        
        // Önce oyun bilgilerini al
        const gamesResponse = await axios.get('https://muhammetdag.com/api/v1/online/online_fix_games.json');
        const games = gamesResponse.data;
        
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
          // Dosyayı temp'e indir
          const downloadResponse = await axios.get(`https://muhammetdag.com/api/v1/online/index.php?appid=${appId}`, {
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
            url: `https://muhammetdag.com/api/v1/online/index.php?appid=${appId}`,
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
    //     const gamesResponse = await axios.get('https://muhammetdag.com/api/v1/online/online_fix_games.json');
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
    //       const downloadResponse = await axios.get(`https://muhammetdag.com/api/v1/online/index.php?appid=${appId}`, {
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
    //         url: `https://muhammetdag.com/api/v1/online/index.php?appid=${appId}`,
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
          games = await this.fetchFeaturedGames();
          break;
        case 'popular':
          games = await this.fetchPopularGames();
          break;
        case 'new':
          games = await this.fetchNewReleases();
          break;
        case 'top':
          games = await this.fetchTopRated();
          break;
        case 'free':
          games = await this.fetchFreeGames();
          break;
        case 'action':
          games = await this.fetchGamesByGenre('Action');
          break;
        case 'rpg':
          games = await this.fetchGamesByGenre('RPG');
          break;
        case 'strategy':
          games = await this.fetchGamesByGenre('Strategy');
          break;
        default:
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
    const response = await axios.get('https://store.steampowered.com/api/featured/', {
      timeout: 10000
    });
    
    if (response.data.featured_win) {
      return response.data.featured_win.map(game => this.processGameData(game));
    }
    return [];
  }

  async fetchPopularGames() {
    const response = await axios.get('https://store.steampowered.com/api/featuredcategories/', {
      timeout: 10000
    });
    
    if (response.data.top_sellers?.items) {
      return response.data.top_sellers.items.map(game => this.processGameData(game));
    }
    return [];
  }

  async fetchNewReleases() {
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
    const response = await axios.get('https://store.steampowered.com/api/featuredcategories/', {
      timeout: 10000
    });
    
    if (response.data.specials?.items) {
      return response.data.specials.items.map(game => this.processGameData(game));
    }
    return [];
  }

  async fetchFreeGames() {
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

      // If no cached results, search Steam API
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
      const gameUrl = `https://muhammetdag.com/api/v1/game.php?steamid=${appId}`;
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
          // 7-Zip ile ayıklama (şifresiz)
          const command = `7z x "${zipPath}" -o"${targetDir}"`;
          
          exec(command, (error, stdout, stderr) => {
            if (error) {
              console.log('7-Zip failed, trying WinRAR...');
              
              // WinRAR ile dene (şifresiz)
              const winrarCommand = `winrar x "${zipPath}" "${targetDir}\\"`;
              
              exec(winrarCommand, (wrError, wrStdout, wrStderr) => {
                if (wrError) {
                  console.log('Both 7-Zip and WinRAR failed');
                  reject(new Error('ZIP extraction failed'));
                } else {
                  console.log('WinRAR extraction successful');
                  resolve();
                }
              });
            } else {
              console.log('7-Zip extraction successful');
              resolve();
            }
          });
        }).catch(error => {
          reject(new Error(`Failed to create target directory: ${error.message}`));
        });
      } catch (error) {
        reject(new Error(`ZIP extraction failed: ${error.message}`));
      }
    });
  }


}

// App event handlers
app.whenReady().then(() => {
  const manager = new SteamLibraryManager();
  manager.createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    const manager = new SteamLibraryManager();
    manager.createWindow();
  }
});