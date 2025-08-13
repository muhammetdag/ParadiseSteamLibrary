const { ipcRenderer } = require('electron');

// Güvenli Steam API çağrısı için yardımcı fonksiyon
async function safeSteamFetch(url, options = {}) {
    try {
        const defaultOptions = {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1'
            },
            timeout: 10000,
            ...options
        };
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), defaultOptions.timeout);
        
        const response = await fetch(url, {
            ...defaultOptions,
            signal: controller.signal
        });
        
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        console.error('Steam API çağrısı hatası:', error);
        throw error;
    }
}

// Steam appdetails için güvenli JSON yardımcı fonksiyonu
async function fetchSteamAppDetails(appid, cc, lang) {
    try {
        let url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&l=${lang}`;
        let res = await safeSteamFetch(url, { timeout: 15000 });

        // 403 ise TR/turkish ile bir kez daha dene
        if (res.status === 403 && !(cc === 'TR' && lang === 'turkish')) {
            await new Promise(r => setTimeout(r, 400));
            res = await safeSteamFetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=TR&l=turkish`, { timeout: 15000 });
        }

        if (!res.ok) return null;

        try {
            const data = await res.json();
            return data[appid]?.data || null;
        } catch {
            // HTML döndüyse JSON parse hatası olur
            return null;
        }
    } catch {
        return null;
    }
}

class SteamLibraryUI {
    constructor() {
        this.currentPage = 'home';
        this.currentCategory = 'featured';
        this.currentGameData = null;
        this.gamesData = [];
        this.libraryGames = [];
        this.config = {};
        this.restartCountdown = null;
        this.searchTimeout = null;
        this.countryCode = null;
        this.aiApiKey = "";
        this.aiApiUrl = "";
        this.aiHistory = [];
        this.appDetailsCache = {};
        
        // Online Pass sayfalama değişkenleri
        this.onlinePassGames = [];
        this.onlinePassCurrentPage = 0;
        this.onlinePassGamesPerPage = 15;
        this.onlinePassFilteredGames = [];
        this.onlinePassNameCache = this.loadOnlinePassNameCache();
        this.appDetailsConsecutiveNulls = 0;
        this.appDetailsBackoffUntil = 0;
        
        // Tüm Oyunlar ve filtre sistemi kaldırıldı
        
        this.init();
    }

    getPlaceholderImage() {
        return 'pdbanner.png';
    }

    loadOnlinePassNameCache() {
        try {
            const raw = localStorage.getItem('onlinePassNameCache');
            if (!raw) return {};
            const parsed = JSON.parse(raw);
            return typeof parsed === 'object' && parsed ? parsed : {};
        } catch {
            return {};
        }
    }

    persistOnlinePassNameCache() {
        try {
            localStorage.setItem('onlinePassNameCache', JSON.stringify(this.onlinePassNameCache || {}));
        } catch {}
    }

    // Command line arguments'dan değer alma fonksiyonu
    getCommandLineArg(argName) {
        const args = process.argv;
        const argIndex = args.indexOf(argName);
        if (argIndex !== -1 && argIndex + 1 < args.length) {
            return args[argIndex + 1];
        }
        return null;
    }

    async init() {
        await this.detectCountryCode();
        this.setupEventListeners();
        await this.loadConfig();
        await this.checkSteamPath();
        this.loadGames();
        this.loadLibrary();
        this.setupKeyboardShortcuts();
        this.setupActiveUsersTracking();
        
        // Başlangıçta tüm modalleri kapat (güvenlik için)
        this.closeAllModals();

        // Discord davetini ilk açılışta sor
        this.maybeAskDiscordInvite();
    }

    async maybeAskDiscordInvite() {
        try {
            // Config üzerinden daha önce sorulup sorulmadığını kontrol et
            const cfg = this.config || await ipcRenderer.invoke('get-config');
            if (cfg.discordInviteAsked) return;
            // Sadece ilk açılışta ve kısa gecikme ile göster
            setTimeout(() => {
                const modal = document.getElementById('discordInviteModal');
                if (!modal) return;
                this.showModal('discordInviteModal');
                const joinBtn = document.getElementById('discordInviteJoinBtn');
                const laterBtn = document.getElementById('discordInviteLaterBtn');
                const markAsked = async () => {
                    try { await ipcRenderer.invoke('save-config', { discordInviteAsked: true }); } catch {}
                };
                if (joinBtn) {
                    joinBtn.onclick = async () => {
                        try {
                            await ipcRenderer.invoke('open-in-chrome', 'https://discord.gg/paradisedev');
                        } catch {
                            window.open('https://discord.gg/paradisedev', '_blank');
                        }
                        await markAsked();
                        this.closeModal('discordInviteModal');
                    };
                }
                if (laterBtn) {
                    laterBtn.onclick = async () => {
                        await markAsked();
                        this.closeModal('discordInviteModal');
                    };
                }
            }, 1200);
        } catch {}
    }

    async detectCountryCode() {
        // Önce localStorage'da var mı bak
        let cc = localStorage.getItem('countryCode');
        if (cc) {
            this.countryCode = cc;
            return;
        }
        // GeoJS ile ülke kodunu al
        try {
            const res = await fetch('https://get.geojs.io/v1/ip/country.json');
            const data = await res.json();
            if (data && data.country) {
                this.countryCode = data.country;
                localStorage.setItem('countryCode', data.country);
                return;
            }
        } catch (e) {
            this.countryCode = 'TR'; // fallback
        }
    }

    updateTranslations() {
        // Tüm data-i18n metinlerini güncelle
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            el.textContent = this.translate(key);
        });
        // Tüm data-i18n-placeholder alanlarını güncelle
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            el.setAttribute('placeholder', this.translate(key));
        });
        // Tüm data-i18n-title alanlarını güncelle
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            el.setAttribute('title', this.translate(key));
        });
    }

    setupEventListeners() {
        // Window controls
        document.getElementById('minimizeBtn').addEventListener('click', () => {
            ipcRenderer.invoke('window-minimize');
        });

        document.getElementById('maximizeBtn').addEventListener('click', () => {
            ipcRenderer.invoke('window-maximize');
        });

        document.getElementById('closeBtn').addEventListener('click', () => {
            ipcRenderer.invoke('window-close');
        });

        // Navigation
        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => {
                this.switchPage(item.dataset.page);
            });
        });

        // Filter tabs
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchCategory(tab.dataset.category);

        // Aktif kullanıcı sayısı göstergesi
        document.getElementById('activeUsersIndicator').addEventListener('click', () => {
            this.refreshActiveUsersCount();
        });
            });
        });

        // Search
        const searchInput = document.getElementById('searchInput');
        searchInput.addEventListener('input', (e) => {
            // Eğer aktif sayfa onlinePass ise, online oyunlarda filtrele
            if (this.getCurrentPage() === 'onlinePass') {
                const query = e.target.value.trim().toLowerCase();
                
                if (!this.onlinePassGames) return;
                
                if (!query) {
                    this.onlinePassFilteredGames = this.onlinePassGames;
                    this.onlinePassCurrentPage = 0;
                    this.renderOnlinePassGames();
                } else {
                    // ID ve isim ile arama yap
                    this.onlinePassFilteredGames = this.onlinePassGames.filter(gameId => {
                        // Null kontrolü
                        if (!gameId) return false;
                        
                        // ID ile arama (her zaman çalışır)
                        try {
                            if (gameId.toString().toLowerCase().includes(query)) {
                                return true;
                            }
                        } catch (error) {
                            console.error('Error converting gameId to string:', error);
                            return false;
                        }
                        
                        // İsim ile arama (önbellekten - eğer varsa)
                        if (this.onlinePassGameNames && this.onlinePassGameNames[gameId]) {
                            try {
                                const gameName = this.onlinePassGameNames[gameId].toLowerCase();
                                return gameName.includes(query);
                            } catch (error) {
                                console.error('Error processing game name:', error);
                                return false;
                            }
                        } else {
                            // İsimler henüz yüklenmemişse, sadece ID ile arama yap
                            // Bu sayede arama hemen çalışır
                        }
                        
                        return false;
                    });
                    this.onlinePassCurrentPage = 0;
                    this.renderOnlinePassGames();
                }
            } else {
                this.handleSearch(e.target.value, false);
            }
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                if (this.getCurrentPage() === 'onlinePass') {
                    // Enter'a basınca da filtrele
                    const query = searchInput.value.trim().toLowerCase();
                    if (!this.onlinePassGames) return;
                    if (!query) {
                        this.onlinePassFilteredGames = this.onlinePassGames;
                        this.onlinePassCurrentPage = 0;
                        this.renderOnlinePassGames();
                    } else {
                        // ID ve isim ile arama yap
                        this.onlinePassFilteredGames = this.onlinePassGames.filter(gameId => {
                            // Null kontrolü
                            if (!gameId) return false;
                            
                            // ID ile arama (her zaman çalışır)
                            try {
                                if (gameId.toString().toLowerCase().includes(query)) {
                                    return true;
                                }
                            } catch (error) {
                                console.error('Error converting gameId to string:', error);
                                return false;
                            }
                            
                            // İsim ile arama (önbellekten - eğer varsa)
                            if (this.onlinePassGameNames && this.onlinePassGameNames[gameId]) {
                                try {
                                    const gameName = this.onlinePassGameNames[gameId].toLowerCase();
                                    return gameName.includes(query);
                                } catch (error) {
                                    console.error('Error processing game name:', error);
                                    return false;
                                }
                            }
                            
                            return false;
                        });
                        this.onlinePassCurrentPage = 0;
                        this.renderOnlinePassGames();
                    }
                } else {
                    this.handleSearch(e.target.value, true);
                }
            }
        });


        

        // Settings
        document.getElementById('browseSteamBtn').addEventListener('click', () => {
            this.selectSteamPath();
        });

        document.getElementById('setupBrowseBtn').addEventListener('click', () => {
            this.selectSteamPath();
        });

        document.getElementById('confirmSetupBtn').addEventListener('click', () => {
            this.confirmSteamSetup();
        });

        // Modal controls
        document.getElementById('modalClose').addEventListener('click', () => {
            this.closeModal('gameModal');
        });

        document.getElementById('dlcModalClose').addEventListener('click', () => {
            this.closeModal('dlcModal');
        });

        // Steam restart
        const restartBtn = document.getElementById('restartSteamBtn');
        if (restartBtn) restartBtn.addEventListener('click', () => {
            this.restartSteam();
        });

        const cancelRestartBtn = document.getElementById('cancelRestartBtn');
        if (cancelRestartBtn) cancelRestartBtn.addEventListener('click', () => {
            this.closeModal('steamRestartModal');
        });

        // Library refresh
        const refreshLibraryBtn = document.getElementById('refreshLibraryBtn');
        if (refreshLibraryBtn) refreshLibraryBtn.addEventListener('click', () => {
            this.refreshLibrary();
        });

        // Load more games
        const loadMoreBtn = document.getElementById('loadMoreBtn');
        if (loadMoreBtn) loadMoreBtn.addEventListener('click', () => {
            this.loadMoreGames();
        });

        // 'Daha fazla' yerine sayfalama kullanılacak; bu alan kaldırıldı

        // Settings toggles
        const discordToggle = document.getElementById('discordRPCToggle');
        if (discordToggle) discordToggle.addEventListener('change', (e) => {
            this.updateConfig({ discordRPC: e.target.checked });
        });
        const videoMutedToggle = document.getElementById('videoMutedToggle');
        if (videoMutedToggle) videoMutedToggle.addEventListener('change', (e) => {
            this.updateConfig({ videoMuted: e.target.checked });
        });



        // Close modals on overlay click
        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    this.closeModal(overlay.id);
                }
            });
        });

        // Hamburger menü ve baloncuklar
        const hamburgerBtn = document.getElementById('hamburgerMenuBtn');
        const bubbleMenu = document.getElementById('bubbleMenu');
        hamburgerBtn.addEventListener('click', () => {
            bubbleMenu.classList.toggle('active');
        });
        // Baloncuklara tıklama
        document.getElementById('bubbleSettings').addEventListener('click', () => {
            this.switchPage('settings');
            bubbleMenu.classList.remove('active');
        });
        document.getElementById('bubbleHome').addEventListener('click', () => {
            this.switchPage('home');
            bubbleMenu.classList.remove('active');
        });
        document.getElementById('bubbleLibrary').addEventListener('click', () => {
            this.switchPage('library');
            bubbleMenu.classList.remove('active');
        });
        const bubbleAllGames = document.getElementById('bubbleAllGames');
        if (bubbleAllGames) bubbleAllGames.remove();
        document.getElementById('bubbleOnlinePass').addEventListener('click', () => {
            this.switchPage('onlinePass');
            bubbleMenu.classList.remove('active');
        });
        document.getElementById('bubbleManualInstall').addEventListener('click', () => {
            this.switchPage('manualInstall');
            bubbleMenu.classList.remove('active');
        });

        // AI Chat widget
        this.setupAIChat();



        

        // Dil seçici butonları
        const langBtns = document.querySelectorAll('.lang-btn');
        const selectedLang = localStorage.getItem('selectedLang') || 'tr';
        langBtns.forEach(btn => {
            if (btn.dataset.lang === selectedLang) btn.classList.add('selected');
            btn.addEventListener('click', () => {
                langBtns.forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                localStorage.setItem('selectedLang', btn.dataset.lang);
                this.updateTranslations();
            });
        });
        
        // Sayfa ilk açıldığında da çevirileri uygula
        this.updateTranslations();
    }

    setupKeyboardShortcuts() {
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'k') {
                e.preventDefault();
                document.getElementById('searchInput').focus();
            }
            
            if (e.key === 'Escape') {
                this.closeAllModals();
            }
        });
    }

    async loadConfig() {
        try {
            this.config = await ipcRenderer.invoke('get-config');
            this.updateSettingsUI();
        } catch (error) {
            console.error('Failed to load config:', error);
            this.showNotification('error', 'config_load_failed', 'error');
        }
    }

    async updateConfig(updates) {
        try {
            this.config = await ipcRenderer.invoke('save-config', updates);
            this.showNotification('success', 'settings_saved', 'success');
        } catch (error) {
            console.error('Failed to update config:', error);
            this.showNotification('error', 'settings_save_failed', 'error');
        }
    }

    updateSettingsUI() {
        document.getElementById('steamPathInput').value = this.config.steamPath || '';
        const discordToggle = document.getElementById('discordRPCToggle');
        if (discordToggle) discordToggle.checked = this.config.discordRPC;
        const videoMutedToggle = document.getElementById('videoMutedToggle');
        if (videoMutedToggle) videoMutedToggle.checked = this.config.videoMuted;
    }

    // AI Chat: widget kurulumu
    setupAIChat() {
        const toggle = document.getElementById('aiChatToggle');
        const widget = document.getElementById('aiChatWidget');
        const closeBtn = document.getElementById('aiChatClose');
        const clearBtn = document.getElementById('aiChatClear');
        const messages = document.getElementById('aiChatMessages');
        const textarea = document.getElementById('aiChatTextarea');
        const sendBtn = document.getElementById('aiChatSend');

        if (!toggle || !widget || !messages || !textarea || !sendBtn) return;

        const show = () => { widget.classList.remove('hidden'); widget.setAttribute('aria-hidden', 'false'); textarea.focus(); };
        const hide = () => { widget.classList.add('hidden'); widget.setAttribute('aria-hidden', 'true'); };
        toggle.onclick = () => widget.classList.contains('hidden') ? show() : hide();
        if (closeBtn) closeBtn.onclick = hide;
        if (clearBtn) clearBtn.onclick = () => { messages.innerHTML = ''; };

        const appendMsg = (role, text) => {
            const row = document.createElement('div');
            row.className = `ai-msg ${role}`;
            const bubble = document.createElement('div');
            bubble.className = 'bubble';
            bubble.textContent = text;
            row.appendChild(bubble);
            messages.appendChild(row);
            messages.scrollTop = messages.scrollHeight;
            this.aiHistory.push({ role, content: text });
            if (this.aiHistory.length > 50) this.aiHistory.shift();
        };

        const send = async () => {
            const content = textarea.value.trim();
            if (!content) return;
            appendMsg('user', content);
            textarea.value = '';
            try {
                const reply = await this.callAI(content, this.aiHistory);
                appendMsg('bot', reply || 'Cevap alınamadı.');
            } catch (e) {
                appendMsg('bot', 'Bir hata oluştu. Daha sonra tekrar deneyin.');
            }
        };

        sendBtn.onclick = send;
        textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
            }
        });
    }

    // AI Chat: API çağrısı
    async callAI(message, history = []) {
        try {
            // Bazı sunucular, header casing ve CORS preflight için farklı davranabilir.
            // Bu yüzden iki denemeli strateji uygula.
            const makeReq = (headerName) => fetch(this.aiApiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    [headerName]: this.aiApiKey,
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    // Sunucu tarafı 'question' alanını bekliyor
                    question: message
                })
            });
            // Yeni uç nokta için tek başlık adı yeterli
            let res = await makeReq('X-API-Key');
            // Yanıtı JSON olarak öncelikle dene, olmazsa metin olarak al
            let data;
            try {
                data = await res.json();
            } catch {
                const text = await res.text();
                data = { text };
            }
            // Esnek parse: {reply}, {message}, {text} gibi alanları dene
            return data.answer || data.reply || data.message || data.text || '';
        } catch (e) {
            console.error('AI API hatası:', e);
            return '';
        }
    }

    async checkSteamPath() {
        if (!this.config.steamPath) {
            // Steam yolu yoksa modal açmak yerine sadece bildirim göster
            this.showNotification('Bilgi', 'Steam yolu ayarlanmamış. Ayarlar sayfasından Steam yolunu belirleyebilirsiniz.', 'info');
        }
    }

    async selectSteamPath() {
        try {
            const steamPath = await ipcRenderer.invoke('select-steam-path');
            if (steamPath) {
                document.getElementById('steamPathInput').value = steamPath;
                document.getElementById('setupSteamPath').value = steamPath;
                this.showNotification('success', 'steam_path_set', 'success');
            }
        } catch (error) {
            console.error('Failed to select Steam path:', error);
            this.showNotification('error', 'steam_path_failed', 'error');
        }
    }

    confirmSteamSetup() {
        const steamPath = document.getElementById('setupSteamPath').value;
        if (steamPath) {
            this.closeModal('steamSetupModal');
            this.showNotification('Başarılı', 'Kurulum başarıyla tamamlandı', 'success');
        }
    }

    switchPage(page) {
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
        const pageEl = document.getElementById(page + 'Page');
        if (pageEl) {
            pageEl.classList.add('active');
            pageEl.style.display = '';
            if (page === 'onlinePass') {
                // Aynı anda tek yükleme: bir önceki yükleme bitmeden tekrar çağırma
                if (this.loadingOnlinePass) return;
                this.loadingOnlinePass = true;
                // İçeriği temizle (idempotent render için)
                pageEl.innerHTML = '';
                this.loadOnlinePassGames().finally(() => {
                    this.loadingOnlinePass = false;
                });
            } else if (page === 'manualInstall') {
                this.setupManualInstallListeners();
            }
        }
    }

    switchCategory(category) {
        // Update filter tabs
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.classList.remove('active');
        });
        document.querySelector(`[data-category="${category}"]`).classList.add('active');

        // Update section title
        const categoryNames = {
            'featured': 'Öne Çıkan Oyunlar',
            'popular': 'Popüler Oyunlar',
            'new': 'Yeni Çıkan Oyunlar',
            'top': 'En İyi Oyunlar',
            'free': 'Ücretsiz Oyunlar',
            'action': 'Aksiyon Oyunları',
            'rpg': 'RPG Oyunları',
            'strategy': 'Strateji Oyunları'
        };
        
        document.getElementById('sectionTitle').textContent = categoryNames[category] || 'Oyunlar';

        this.currentCategory = category;
        this.loadGames();
    }

    async loadAllGames() {
        // Tüm Oyunlar sayfası için daha fazla oyun yükle
        this.showLoading();
        try {
            const cc = this.countryCode || 'TR';
            const lang = this.getSelectedLang();
            
            // Popüler oyunları Steam'den çek
            const resultsUrl = `https://store.steampowered.com/search/results?sort_by=Reviews_DESC&category1=998&force_infinite=1&start=0&count=50&supportedlang=turkish&ndl=1&snr=1_7_7_151_7`;
            
            try {
                console.log('Steam arama sonuçları alınıyor...');
                const response = await fetch(resultsUrl, {
                    method: 'GET',
                    headers: {
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
                        'Accept-Encoding': 'gzip, deflate, br',
                        'Connection': 'keep-alive',
                        'Cache-Control': 'no-cache'
                    },
                    timeout: 20000
                });
                
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                }
                
                const html = await response.text();
                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');
                const rows = doc.querySelectorAll('.search_result_row');
                
                if (rows.length === 0) {
                    throw new Error('Steam arama sonuçları bulunamadı');
                }
                
                console.log(`${rows.length} oyun bulundu, detaylar alınıyor...`);
                
                // Her oyun için detay çek
                const newGamesRaw = Array.from(rows).map(row => {
                    const appid = row.getAttribute('data-ds-appid');
                    const name = row.querySelector('.title')?.textContent?.trim() || '';
                    return { appid, name };
                }).filter(game => game.appid && game.name);
                
                // Her oyun için detaylı veri çek (hata yönetimi ile)
                const games = await Promise.allSettled(newGamesRaw.slice(0, 50).map(async (game, index) => {
                    try {
                        console.log(`Oyun ${game.appid} detayları alınıyor...`);
                        const gameData = await fetchSteamAppDetails(game.appid, cc, lang);
                        
                        if (!gameData || !gameData.name) {
                            throw new Error('Oyun verisi bulunamadı');
                        }
                        
                        console.log(`Oyun ${game.appid} başarıyla yüklendi: ${gameData.name}`);
                        
                        return {
                            appid: game.appid,
                            name: gameData.name,
                            header_image: gameData.header_image || `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/capsule_616x353.jpg`,
                            price: gameData.price_overview ? gameData.price_overview : 0,
                            price_overview: gameData.price_overview,
                            discount_percent: gameData.price_overview ? gameData.price_overview.discount_percent : 0,
                            platforms: gameData.platforms || {},
                            coming_soon: gameData.release_date?.coming_soon || false,
                            tags: [],
                            genres: gameData.genres || [],
                            short_description: gameData.short_description || '',
                            reviews: gameData.recommendations ? 'Çok Olumlu' : '',
                            metacritic: gameData.metacritic,
                            release_date: gameData.release_date,
                            is_dlc: false
                        };
                    } catch (error) {
                        console.error(`Oyun ${game.appid} yüklenirken hata:`, error);
                        // Fallback oyun verisi
                        return {
                            appid: game.appid,
                            name: game.name || `Oyun ${game.appid}`,
                            header_image: `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/capsule_616x353.jpg`,
                            price: 0,
                            price_overview: null,
                            discount_percent: 0,
                            platforms: {},
                            coming_soon: false,
                            tags: [],
                            genres: [],
                            short_description: 'Oyun bilgileri yüklenemedi',
                            reviews: '',
                            metacritic: null,
                            release_date: null,
                            is_dlc: false
                        };
                    }
                }));
                
                // Başarılı olan oyunları filtrele
                this.gamesData = games
                    .filter(result => result.status === 'fulfilled' && result.value)
                    .map(result => result.value);
                
                this.filteredAllGames = [...this.gamesData];
                
                if (this.gamesData.length > 0) {
                    console.log(`${this.gamesData.length} oyun başarıyla yüklendi`);
                    this.sortAllGames();
                    this.renderFilteredAllGames();
                    this.updateAllGamesFilterResults();
                } else {
                    throw new Error('Hiç oyun yüklenemedi');
                }
                
            } catch (searchError) {
                console.error('Steam arama hatası:', searchError);
                throw new Error('Steam arama sonuçları alınamadı');
            }
            
        } catch (error) {
            console.error('Tüm oyunlar yüklenirken genel hata:', error);
            
            // Hata durumunda fallback oyunları göster
            const fallbackAppIds = [1436990,2300230,2255360,2418490,2358720,2749880,1593500,3181470,1941540,1174180];
            this.gamesData = fallbackAppIds.map(appid => ({
                appid: appid,
                name: `Oyun ${appid}`,
                header_image: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/capsule_616x353.jpg`,
                price: 0,
                price_overview: null,
                discount_percent: 0,
                platforms: {},
                coming_soon: false,
                tags: [],
                genres: [],
                short_description: 'Oyun bilgileri yüklenemedi',
                reviews: '',
                metacritic: null,
                release_date: null,
                is_dlc: false
            }));
            
            this.filteredAllGames = [...this.gamesData];
            this.renderFilteredAllGames();
            this.updateAllGamesFilterResults();
            
            this.showNotification('Uyarı', 'Bazı oyun bilgileri yüklenemedi. Temel bilgiler gösteriliyor.', 'warning');
        } finally {
            this.hideLoading();
        }
    }

    // Kategori sistemi kaldırıldı, ana sayfa sadece belirli oyunları gösterir
    async loadGames() {
        let featuredAppIds = [1436990,2300230,2255360,2418490,2358720,2749880,1593500,3181470,1941540,1174180];
        for (let i = featuredAppIds.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [featuredAppIds[i], featuredAppIds[j]] = [featuredAppIds[j], featuredAppIds[i]];
        }
        
        this.showLoading();
        try {
            const cc = this.countryCode || 'TR';
            const lang = this.getSelectedLang();
            
            // Önce basit oyun verilerini yükle (fallback için)
            const fallbackGames = featuredAppIds.slice(0, 10).map(appid => ({
                appid: appid,
                name: `Oyun ${appid}`,
                header_image: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/capsule_616x353.jpg`,
                price: 0,
                price_overview: null,
                discount_percent: 0,
                platforms: {},
                coming_soon: false,
                tags: [],
                genres: [],
                short_description: 'Oyun bilgileri yükleniyor...',
                reviews: '',
                metacritic: null,
                is_dlc: false
            }));
            
            // Hata yönetimi ile oyun yükleme
            const games = await Promise.allSettled(featuredAppIds.slice(0, 9).map(async (appid, index) => {
                try {
                    console.log(`Oyun ${appid} yükleniyor...`);
                    const gameData = await fetchSteamAppDetails(appid, cc, lang);
                    
                    if (!gameData || !gameData.name) {
                        throw new Error('Oyun verisi bulunamadı');
                    }
                    
                    console.log(`Oyun ${appid} başarıyla yüklendi: ${gameData.name}`);
                    
                    return {
                        appid: appid,
                        name: gameData.name,
                        header_image: gameData.header_image || `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/capsule_616x353.jpg`,
                        price: gameData.price_overview ? gameData.price_overview : 0,
                        price_overview: gameData.price_overview,
                        discount_percent: gameData.price_overview ? gameData.price_overview.discount_percent : 0,
                        platforms: gameData.platforms || {},
                        coming_soon: gameData.release_date?.coming_soon || false,
                        tags: [],
                        genres: gameData.genres || [],
                        short_description: gameData.short_description || '',
                        reviews: gameData.recommendations ? 'Çok Olumlu' : '',
                        metacritic: gameData.metacritic,
                        is_dlc: false
                    };
                } catch (error) {
                    console.warn(`Oyun ${appid} yüklenirken hata:`, error?.message || error);
                    // Fallback oyun verisi döndür
                    return fallbackGames[index];
                }
            }));
            
            // Başarılı olan oyunları filtrele
            this.gamesData = games
                .filter(result => result.status === 'fulfilled' && result.value)
                .map(result => result.value);
            
            this.filteredAllGames = [...this.gamesData];
            
            // En az bir oyun yüklendiyse devam et
            if (this.gamesData.length > 0) {
                await this.renderGames();
                this.updateHeroSection();
                console.log(`${this.gamesData.length} oyun başarıyla yüklendi`);
            } else {
                throw new Error('Hiç oyun yüklenemedi');
            }
            
        } catch (error) {
            console.error('Oyunlar yüklenirken genel hata:', error);
            
            // Hata durumunda fallback oyunları göster
            this.gamesData = featuredAppIds.slice(0, 9).map(appid => ({
                appid: appid,
                name: `Oyun ${appid}`,
                header_image: `https://cdn.akamai.steamstatic.com/steam/apps/${appid}/capsule_616x353.jpg`,
                price: 0,
                price_overview: null,
                discount_percent: 0,
                platforms: {},
                coming_soon: false,
                tags: [],
                genres: [],
                short_description: 'Oyun bilgileri yüklenemedi',
                reviews: '',
                metacritic: null,
                is_dlc: false
            }));
            
            this.filteredAllGames = [...this.gamesData];
            await this.renderGames();
            this.updateHeroSection();
            
            this.showNotification('Uyarı', 'Bazı oyun bilgileri yüklenemedi. Temel bilgiler gösteriliyor.', 'warning');
        } finally {
            this.hideLoading();
        }
    }

    async renderGames() {
        const gamesGrid = document.getElementById('gamesGrid');
        gamesGrid.innerHTML = '';

        if (this.gamesData.length === 0) {
            gamesGrid.innerHTML = `
                <div class="no-games" style="grid-column: 1 / -1; text-align: center; padding: 40px; color: var(--text-secondary);">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="margin-bottom: 16px;">
                        <circle cx="11" cy="11" r="8"/>
                        <path d="m21 21-4.35-4.35"/>
                    </svg>
                    <h3>Hiç oyun bulunamadı</h3>
                    <p>Oyunlar yüklenirken bir hata oluştu. Lütfen sayfayı yenileyin.</p>
                    <button onclick="location.reload()" style="margin-top: 16px; padding: 8px 16px; background: var(--accent-primary); color: white; border: none; border-radius: 6px; cursor: pointer;">
                        Sayfayı Yenile
                    </button>
                </div>
            `;
            return;
        }

        // Oyun kartlarını paralel olarak oluştur
        const cardPromises = this.gamesData.map(async game => {
            try {
                return await this.createGameCard(game);
            } catch (error) {
                console.error('Game card creation failed:', error);
                // Hata durumunda basit bir kart oluştur
                const fallbackCard = document.createElement('div');
                fallbackCard.className = 'game-card';
                fallbackCard.innerHTML = `
                    <img src="${game.header_image || `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/header.jpg`}" alt="${game.name}" class="game-image" loading="lazy" style="width:100%;height:180px;object-fit:cover;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.18);" onerror="this.onerror=null;this.src='pdbanner.png'">
                    <div class="game-info">
                        <h3 class="game-title" style="font-size:18px;font-weight:700;margin-bottom:4px;">${game.name}</h3>
                        <div class="game-meta" style="margin-bottom:6px;">
                            <span class="game-price" style="font-size:16px;font-weight:600;">Ücretsiz</span>
                        </div>
                        <div class="game-tags"></div>
                        <div class="game-actions">
                            <button class="game-btn primary" onclick="event.stopPropagation(); ui.addGameToLibrary(${game.appid})">Kütüphaneme Ekle</button>
                            <button class="game-btn secondary" onclick="event.stopPropagation(); ui.openSteamPage(${game.appid})">Steam Sayfası</button>
                        </div>
                    </div>
                `;
                fallbackCard.addEventListener('click', () => this.showGameDetails(game));
                return fallbackCard;
            }
        });
        
        const cards = await Promise.all(cardPromises);
        
        cards.forEach(card => {
            if (card) {
                gamesGrid.appendChild(card);
            }
        });
    }

    // Oyun kartı oluşturulurken butonlara data-i18n ekle
    async createGameCard(game, isLibrary = false) {
        // Game objesi kontrolü
        if (!game || !game.appid || !game.name) {
            console.error('Invalid game object:', game);
            return null;
        }
        
        const card = document.createElement('div');
        card.className = 'game-card';
        card.addEventListener('click', () => this.showGameDetails(game));

        // Akıllı görsel çekme sistemi
        let imageUrl = game.header_image;
        if (!imageUrl && game.appid) {
            imageUrl = await this.getGameImageUrl(game.appid, game.name);
        }
        
        // Fallback görsel URL'si
        if (!imageUrl) {
            imageUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${game.appid}/capsule_616x353.jpg`;
        }

        const tagsHtml = game.tags ? game.tags.map(tag => 
            `<span class="game-tag" style="background-color: ${tag.color}">${tag.name}</span>`
        ).join('') : '';

        // Oyun kütüphanede mi kontrol et
        const isInLibrary = this.libraryGames && this.libraryGames.some(libGame => libGame.appid == game.appid);

        let actionsHtml = '';
        if (isInLibrary) {
            actionsHtml = `
                <button class="game-btn primary" data-i18n="start_game" onclick="event.stopPropagation(); ui.launchGame(${game.appid})">${this.translate('start_game')}</button>
                <button class="game-btn secondary" data-i18n="remove_game" onclick="event.stopPropagation(); ui.deleteGame(${game.appid})">${this.translate('remove_game')}</button>
            `;
        } else {
            actionsHtml = `
                <button class="game-btn primary" data-i18n="add_to_library" ${isInLibrary ? 'disabled' : ''} onclick="event.stopPropagation(); ${isInLibrary ? '' : `ui.addGameToLibrary(${game.appid})`}">${isInLibrary ? this.translate('already_added') : this.translate('add_to_library')}</button>
                <button class="game-btn secondary" data-i18n="steam_page" onclick="event.stopPropagation(); ui.openSteamPage(${game.appid})">${this.translate('steam_page')}</button>
            `;
        }

        // Fiyat ve indirim sadece kütüphane dışı kartlarda gösterilsin
        let priceHtml = '';
        if (!isLibrary) {
            let priceText = '';
            try {
                if (!game.price || game.price === 0 || game.price === '0') {
                    priceText = this.translate('free');
                } else {
                    // Para birimi ve sayı formatı
                    let symbol = '₺';
                    if (typeof game.price === 'object' && game.price.currency) {
                        const currency = game.price.currency;
                        symbol = currency === 'TRY' ? '₺' : (currency === 'USD' ? '$' : (currency === 'EUR' ? '€' : currency));
                        priceText = `${symbol}${(game.price.final / 100).toLocaleString(this.getSelectedLang(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                    } else {
                        priceText = `${symbol}${(game.price / 100).toLocaleString(this.getSelectedLang(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                    }
                }
            } catch (error) {
                console.error('Fiyat formatı hatası:', error);
                priceText = this.translate('free');
            }
            priceHtml = `<span class="game-price" style="font-size:16px;font-weight:600;">${priceText}</span>`;
            if (game.discount_percent > 0) {
                priceHtml += `<span class="game-discount">${game.discount_percent}% ${this.translate('discount')}</span>`;
            }
        }

        card.innerHTML = `
            <img src="${imageUrl}" alt="${game.name}" class="game-image" loading="lazy" style="width:100%;height:180px;object-fit:cover;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.18);" onerror="this.onerror=null;this.src='pdbanner.png'">
            <div class="game-info">
                <h3 class="game-title" style="font-size:18px;font-weight:700;margin-bottom:4px;">${game.name}</h3>
                <div class="game-meta" style="margin-bottom:6px;">
                    ${priceHtml}
                </div>
                <div class="game-tags">${tagsHtml}</div>
                <div class="game-actions">${actionsHtml}</div>
            </div>
        `;

        return card;
    }

    // Hero alanında slayt
    async updateHeroSection() {
        if (this.gamesData.length === 0) return;
        let index = 0;
        const selectedLang = this.getSelectedLang();
        const cc = langToCountry[selectedLang] || selectedLang.toUpperCase() || 'US';
        const update = async () => {
            const featuredGame = this.gamesData[index];
        const heroTitle = document.getElementById('heroTitle');
        const heroDescription = document.getElementById('heroDescription');
        const heroPrice = document.getElementById('heroPrice');
        const heroBackground = document.getElementById('heroBackground');
        heroTitle.textContent = featuredGame.name;
            // Açıklamayı sade ve kısa göster
            let desc = '';
            try {
                let gameData = this.appDetailsCache[featuredGame.appid];
                if (!gameData) {
                    const res = await fetch(`https://store.steampowered.com/api/appdetails?appids=${featuredGame.appid}&cc=${cc}&l=${selectedLang}`);
                    const data = await res.json();
                    gameData = data[featuredGame.appid]?.data;
                    if (gameData) this.appDetailsCache[featuredGame.appid] = gameData;
                }
                desc = gameData?.short_description || '';
                // HTML etiketlerini temizle ve kısalt
                desc = desc.replace(/<[^>]+>/g, '').trim();
                if (desc.length > 200) desc = desc.slice(0, 200) + '...';
            } catch {}
            heroDescription.textContent = desc || this.translate('discovering_games');
            // Fiyat gösterimi
            let priceText = '';
            if (!featuredGame.price || featuredGame.price === 0 || featuredGame.price === '0') {
                priceText = this.translate('free');
            } else {
                let symbol = '₺';
                if (typeof featuredGame.price === 'object' && featuredGame.price.currency) {
                    const currency = featuredGame.price.currency;
                    symbol = currency === 'TRY' ? '₺' : (currency === 'USD' ? '$' : (currency === 'EUR' ? '€' : currency));
                    priceText = `${symbol}${(featuredGame.price.final / 100).toLocaleString(this.getSelectedLang(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                } else {
                    priceText = `${symbol}${(featuredGame.price / 100).toLocaleString(this.getSelectedLang(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                }
            }
            if (heroPrice) heroPrice.textContent = priceText;
        if (featuredGame.header_image) {
            heroBackground.style.backgroundImage = `url(${featuredGame.header_image})`;
        } else if (featuredGame.appid) {
            const fallbackImage = await this.getGameImageUrl(featuredGame.appid, featuredGame.name);
            heroBackground.style.backgroundImage = `url(${fallbackImage})`;
        }
            // Butonlar
            const viewBtn = document.getElementById('heroViewBtn');
            const addBtn = document.getElementById('heroLibraryBtn');
            if (viewBtn) {
                viewBtn.onclick = (e) => {
                    e.stopPropagation();
                    this.showGameDetails(featuredGame);
                };
                viewBtn.innerText = this.translate('view_details');
            }
            if (addBtn) {
                // Kütüphanede var mı kontrolü
                const isInLibrary = this.libraryGames && this.libraryGames.some(libGame => libGame.appid == featuredGame.appid);
                addBtn.disabled = isInLibrary;
                addBtn.innerText = isInLibrary ? this.translate('already_added') : this.translate('add_to_library');
                addBtn.onclick = (e) => {
                    e.stopPropagation();
                    if (!isInLibrary) this.addGameToLibrary(featuredGame.appid);
                };
            }
            index = (index + 1) % this.gamesData.length;
        };
        await update();
        if (this.heroInterval) clearInterval(this.heroInterval);
        // Daha seyrek güncelle (15s) ve görünür ise çalıştır
        this.heroInterval = setInterval(() => {
            if (document.hidden) return; // sekme görünür değilse atla
            update();
        }, 15000);
    }

    async showGameDetails(game) {
        this.showLoading();
        try {
            const selectedLang = this.getSelectedLang();
            const gameDetails = await ipcRenderer.invoke('fetch-game-details', game.appid, selectedLang);
            if (gameDetails) {
                this.currentGameData = gameDetails;
                this.renderGameModal(gameDetails);
                this.showModal('gameModal');
            }
        } catch (error) {
            console.error('Failed to load game details:', error);
            this.showNotification('Hata', 'Oyun detayları yüklenemedi', 'error');
        } finally {
            this.hideLoading();
        }
    }

    // Modal state temizliği için yardımcı fonksiyon
    clearGameModalState() {
        const mainImage = document.getElementById('modalMainImage');
        const videoContainer = document.getElementById('modalVideoContainer');
        const previewThumbnails = document.getElementById('modalPreviewThumbnails');
        if (mainImage) {
            mainImage.src = '';
            mainImage.style.display = 'none';
        }
        if (videoContainer) videoContainer.innerHTML = '';
        if (previewThumbnails) previewThumbnails.innerHTML = '';
    }

    async renderGameModal(game) {
        const selectedLang = this.getSelectedLang();
        let cc = langToCountry[selectedLang] || selectedLang.toUpperCase() || 'TR';
        let lang = selectedLang || 'turkish';
        if (!cc || cc.length !== 2) cc = 'TR';
        if (!lang) lang = 'turkish';
        const modal = document.getElementById('gameModal');
        const mainImage = document.getElementById('modalMainImage');
        const videoContainer = document.getElementById('modalVideoContainer');
        const previewThumbnails = document.getElementById('modalPreviewThumbnails');
        let videoEl = null;
        // Modern galeri/slider için medya dizisi oluştur
        let media = [];
        let hasVideo = game.movies && game.movies.length > 0 && game.movies[0].mp4;
        if (hasVideo) {
            media.push({ type: 'video', src: game.movies[0].mp4.max || game.movies[0].mp4[480] || '', thumb: game.movies[0].thumbnail || '', title: 'Video' });
        }
        media.push({ type: 'image', src: game.header_image, thumb: game.header_image, title: 'Kapak' });
        let screenshots = Array.isArray(game.screenshots) ? game.screenshots : [];
        screenshots.forEach((s, i) => {
            media.push({ type: 'image', src: s.path_full || s, thumb: s.path_thumbnail || s.path_full || s, title: `Ekran Görüntüsü ${i+1}` });
        });
        let activeIndex = 0;
        const config = this.config;
        // Galeri ana fonksiyonu
        const renderGallery = (idx) => {
            activeIndex = idx;
            // Temizle
            videoContainer.innerHTML = '';
            mainImage.style.display = 'none';
            // Aktif medya göster
            const item = media[activeIndex];
            if (item.type === 'video') {
                videoEl = document.createElement('video');
                videoEl.src = item.src;
                videoEl.controls = true;
                videoEl.className = 'modal-media-main';
                videoEl.style.width = '100%';
                videoEl.style.maxHeight = '340px';
                videoEl.style.objectFit = 'cover';
                videoEl.style.background = '#000';
                videoEl.autoplay = true;
                videoEl.muted = !!config.videoMuted;
                videoContainer.appendChild(videoEl);
            } else {
                mainImage.src = item.src;
                mainImage.className = 'modal-media-main';
                mainImage.style.display = 'block';
            }
            // Thumbnailları güncelle
            previewThumbnails.innerHTML = '';
            media.forEach((m, i) => {
                const thumb = document.createElement(m.type === 'video' ? 'button' : 'img');
                if (m.type === 'video') {
                    thumb.innerHTML = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5,3 19,12 5,21"/></svg>';
                    thumb.title = m.title;
                } else {
                    thumb.src = m.thumb;
                    thumb.title = m.title;
                }
                if (i === activeIndex) thumb.classList.add('active');
                thumb.onclick = () => renderGallery(i);
                previewThumbnails.appendChild(thumb);
            });
        };
        // Ok tuşları ile geçiş
        modal.onkeydown = (e) => {
            if (e.key === 'ArrowLeft') {
                renderGallery((activeIndex - 1 + media.length) % media.length);
            } else if (e.key === 'ArrowRight') {
                renderGallery((activeIndex + 1) % media.length);
            }
        };
        // Modal açıldığında focus al
        setTimeout(() => { modal.focus && modal.focus(); }, 200);
        // İlk medya göster
        renderGallery(0);
        // ... mevcut modal içeriği ve diğer alanlar ...
        document.getElementById('modalTitle').textContent = game.name;
        document.getElementById('modalDeveloper').textContent = game.developers ? game.developers.join(', ') : 'Bilinmiyor';
        document.getElementById('modalReleaseDate').textContent = game.release_date ? game.release_date.date : 'Bilinmiyor';
        // Dil seçenekleri ve açıklama
        // Açıklama alanı için sadece seçili dilde veri çek
        let descFound = false;
        let desc = '';
        const descEl = document.getElementById('modalDescription');
        if (descEl) descEl.classList.add('modal-description');
        // --- BURADAKİ TEKRAR TANIMLAMALARI SİLİYORUM ---
        // const selectedLang = this.getSelectedLang();
        // let cc = langToCountry[selectedLang] || selectedLang.toUpperCase() || 'TR';
        // let lang = selectedLang || 'turkish';
        // if (!cc || cc.length !== 2) cc = 'TR';
        // if (!lang) lang = 'turkish';
        // --- SONU ---
        try {
            const url = `https://store.steampowered.com/api/appdetails?appids=${game.appid}&cc=${cc}&l=${lang}`;
            const resLang = await safeSteamFetch(url);
            let descGameData;
            if (resLang.status === 403 && cc !== 'TR') {
                // fallback TR/turkish ile tekrar dene
                const fallbackRes = await safeSteamFetch(`https://store.steampowered.com/api/appdetails?appids=${game.appid}&cc=TR&l=turkish`);
                if (fallbackRes.ok) {
                    const dataLang = await fallbackRes.json();
                    descGameData = dataLang[game.appid]?.data;
                }
            } else if (resLang.ok) {
                const dataLang = await resLang.json();
                descGameData = dataLang[game.appid]?.data;
            }
            if (descGameData) {
                desc = descGameData.about_the_game || descGameData.detailed_description || descGameData.descriptions?.[lang] || descGameData.short_description || '';
                desc = desc.trim().replace(/^<br\s*\/?>|<br\s*\/?>$/gi, '');
                if (desc) {
                    if (/<[a-z][\s\S]*>/i.test(desc)) {
                        descEl.innerHTML = desc;
                    } else {
                        descEl.textContent = desc;
                    }
                    descFound = true;
                }
            }
        } catch {}
        // Google Translate fallback
        if (!descFound) {
            let fallbackDesc = '';
            if (game.about_the_game) fallbackDesc = game.about_the_game.trim();
            else if (game.detailed_description) fallbackDesc = game.detailed_description.trim();
            else if (game.descriptions && Object.values(game.descriptions).length > 0) fallbackDesc = Object.values(game.descriptions)[0].trim();
            else if (game.short_description) fallbackDesc = game.short_description.trim();
            if (fallbackDesc) {
                try {
                    const sl = 'en'; // varsayılan kaynak dil
                    const tl = selectedLang;
                    const translateRes = await safeSteamFetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(fallbackDesc)}`);
                    const translateData = await translateRes.json();
                    const translated = translateData[0]?.map(part => part[0]).join(' ');
                    if (/<[a-z][\s\S]*>/i.test(translated)) {
                        descEl.innerHTML = translated;
                    } else {
                        descEl.textContent = translated;
                    }
                    descFound = true;
                } catch {
                    descEl.textContent = this.translate('no_description');
                }
            } else {
                descEl.textContent = this.translate('no_description');
            }
        }
        // Oyun detay bilgilerini estetik göster
        const dev = game.developers ? game.developers.join(', ') : 'Bilinmiyor';
        const pub = game.publishers ? game.publishers.join(', ') : 'Bilinmiyor';
        const release = game.release_date ? game.release_date.date : 'Bilinmiyor';
        const modalDevDetail = document.getElementById('modalDevDetail');
        if (modalDevDetail) modalDevDetail.textContent = dev;
        const modalPublisher = document.getElementById('modalPublisher');
        if (modalPublisher) modalPublisher.textContent = pub;
        const modalRelease = document.getElementById('modalRelease');
        if (modalRelease) modalRelease.textContent = release;
        // İncelemeler çevirisi
        const reviewsContainer = document.getElementById('modalReviews');
        let reviewText = game.reviews || '';
        if (reviewText) {
            // Eğer seçili dilde değilse Google Translate ile çevir
            try {
                const sl = 'en'; // varsayılan kaynak dil
                const tl = selectedLang;
                const translateRes = await safeSteamFetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(reviewText)}`);
                const translateData = await translateRes.json();
                const translated = translateData[0]?.map(part => part[0]).join(' ');
                reviewsContainer.textContent = translated;
            } catch {
                reviewsContainer.textContent = reviewText;
            }
        } else {
            reviewsContainer.textContent = '';
        }
        // Değerlendirme (rating) alanını kaldır
        const ratingEl = document.getElementById('modalRating');
        if (ratingEl && ratingEl.parentElement) {
            ratingEl.parentElement.style.display = 'none';
        }
        // Render genres
        const genresContainer = document.getElementById('modalGenres');
        genresContainer.innerHTML = '';
        if (game.genres) {
            game.genres.forEach(genre => {
                const genreTag = document.createElement('span');
                genreTag.className = 'genre-tag';
                genreTag.textContent = genre.description;
                genresContainer.appendChild(genreTag);
            });
        }
        // Update modal buttons
        const addBtn = document.getElementById('modalAddBtn');
        const steamBtn = document.getElementById('modalSteamBtn');
        const startBtn = document.getElementById('modalStartBtn');
        const isInLibrary = this.libraryGames && this.libraryGames.some(libGame => libGame.appid == game.appid);
        if (addBtn) {
            addBtn.style.display = isInLibrary ? 'none' : '';
            addBtn.textContent = this.translate('add_to_library');
            addBtn.disabled = isInLibrary;
            // Eski event'leri temizle, yeni buton oluştur
            const newBtn = addBtn.cloneNode(true);
            addBtn.parentNode.replaceChild(newBtn, addBtn);
            newBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (!isInLibrary) this.addGameToLibrary(game.appid);
            });
        }
        if (startBtn) {
            startBtn.style.display = isInLibrary ? '' : 'none';
            startBtn.textContent = this.translate('start_game');
            startBtn.disabled = !isInLibrary;
            startBtn.onclick = (e) => {
                e.stopPropagation();
                if (isInLibrary) this.launchGame(game.appid);
            };
        }
        if (steamBtn) steamBtn.textContent = this.translate('open_in_steam');
        // Fiyat gösterimi (düzeltildi)
        const priceEl = document.getElementById('modalPrice');
        if (priceEl) {
            let priceText = '';
            if (!game.price || game.price === 0 || game.price === '0') {
                priceText = this.translate('free');
            } else if (typeof game.price === 'object' && game.price.final) {
                // Steam API price objesi
                let currency = game.price.currency || 'TRY';
                let symbol = currency === 'TRY' ? '₺' : (currency === 'USD' ? '$' : (currency === 'EUR' ? '€' : currency));
                priceText = `${symbol}${(game.price.final / 100).toFixed(2)}`;
            } else if (!isNaN(game.price)) {
                // Sadece sayı ise
                let symbol = '₺';
                priceText = `${symbol}${(game.price / 100).toFixed(2)}`;
            } else {
                priceText = this.translate('free');
            }
            priceEl.textContent = priceText;
        }
    }

    async addGameToLibrary(appId) {
        if (!this.config.steamPath) {
            this.showNotification('error', 'steam_path_failed', 'error');
            return;
        }
        // Oyun dosyası API kontrolü (404 ise oyun yok)
        try {
            const res = await fetch(`https://api.muhammetdag.com/steamlib/game/game.php?steamid=${appId}`);
            if (res.status === 404) {
                this.showNotification('error', 'game_not_found', 'error');
                return;
            }
        } catch {
            this.showNotification('error', 'game_not_found', 'error');
            return;
        }
        // Check if game has DLCs ve oyun dosyası var mı kontrolü
        const gameDetails = await ipcRenderer.invoke('fetch-game-details', appId);
        if (!gameDetails || !gameDetails.appid) {
            this.showNotification('error', 'game_not_found', 'error');
            return;
        }
        if (gameDetails && gameDetails.dlc && gameDetails.dlc.length > 0) {
            // DLC ekranı açılır, kullanıcı seçim yapmazsa ana oyun yine de eklenmeli
            this.showDLCSelection(gameDetails, appId);
            return;
        }
        // Add game without DLCs
        this.showLoading();
        try {
            const result = await ipcRenderer.invoke('add-game-to-library', appId, []);
            if (result.success) {
                this.showNotification('success', 'game_added', 'success');
                this.closeModal('gameModal');
                this.showSteamRestartDialog();
            }
        } catch (error) {
            console.error('Failed to add game:', error);
            this.showNotification('error', 'game_add_failed', 'error');
        } finally {
            this.hideLoading();
        }
    }

    // DLC seçim ekranı: Kullanıcı modalı kapatırsa ana oyun eklensin
    showDLCSelection(gameDetails, appId) {
        const dlcList = document.getElementById('dlcList');
        dlcList.innerHTML = '';
        const selectedLang = this.getSelectedLang();
        let cc = langToCountry[selectedLang] || selectedLang.toUpperCase() || 'TR';
        let lang = selectedLang || 'turkish';
        if (!cc || cc.length !== 2) cc = 'TR';
        if (!lang) lang = 'turkish';
        const selectAllCheckbox = document.getElementById('selectAllDLC');
        let selectedDLCs = new Set();
        const grid = document.createElement('div');
        grid.className = 'dlc-grid';
        Promise.all((gameDetails.dlc || []).map(async dlcId => {
            try {
                const url = `https://store.steampowered.com/api/appdetails?appids=${dlcId}&cc=${cc}&l=${lang}`;
                const res = await safeSteamFetch(url);
                if (res.status === 403 && cc !== 'TR') {
                    const fallbackRes = await safeSteamFetch(`https://store.steampowered.com/api/appdetails?appids=${dlcId}&cc=TR&l=turkish`);
                    if (!fallbackRes.ok) return null;
                    const data = await fallbackRes.json();
                    var dlc = data[dlcId]?.data;
                } else {
                    if (!res.ok) return null;
                    const data = await res.json();
                    var dlc = data[dlcId]?.data;
                }
                if (!dlc) return null;
                let title = dlc.name || '';
                let desc = dlc.short_description || '';
                if (!desc) {
                    try {
                        const sl = 'en';
                        const tl = lang;
                        const translateRes = await safeSteamFetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(dlc.name)}`);
                        const translateData = await translateRes.json();
                        title = translateData[0]?.map(part => part[0]).join(' ');
                    } catch {}
                }
                if (!desc) {
                    try {
                        const sl = 'en';
                        const tl = lang;
                        const translateRes = await safeSteamFetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(dlc.short_description || dlc.name)}`);
                        const translateData = await translateRes.json();
                        desc = translateData[0]?.map(part => part[0]).join(' ');
                    } catch {}
                }
                let priceText = '';
                if (!dlc.price_overview || dlc.price_overview.final === 0) {
                    priceText = this.translate('dlc_free');
                } else {
                    let symbol = '₺';
                    const currency = dlc.price_overview.currency;
                    symbol = currency === 'TRY' ? '₺' : (currency === 'USD' ? '$' : (currency === 'EUR' ? '€' : currency));
                    priceText = `${symbol}${(dlc.price_overview.final / 100).toLocaleString(lang, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
                }
                const release = dlc.release_date?.date || '';
                const card = document.createElement('div');
                card.className = 'dlc-card';
                card.style.position = 'relative';
                const checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.className = 'dlc-select-checkbox';
                checkbox.style.position = 'absolute';
                checkbox.style.top = '12px';
                checkbox.style.left = '12px';
                checkbox.value = dlcId;
                checkbox.addEventListener('change', (e) => {
                    if (e.target.checked) {
                        selectedDLCs.add(dlcId);
                    } else {
                        selectedDLCs.delete(dlcId);
                    }
                    if (selectAllCheckbox) {
                        const allCheckboxes = grid.querySelectorAll('.dlc-select-checkbox');
                        selectAllCheckbox.checked = Array.from(allCheckboxes).every(cb => cb.checked);
                    }
                });
                card.appendChild(checkbox);
                card.innerHTML += `
                    <img src="${dlc.header_image}" alt="${title}" class="dlc-image" />
            <div class="dlc-info">
                        <div class="dlc-title">${title}</div>
                        <div class="dlc-desc">${desc}</div>
                        <div class="dlc-meta">
                            <span class="dlc-price">${priceText}</span>
                            <span class="dlc-release">${release}</span>
            </div>
                </div>
            `;
                return card;
            } catch {
                return null;
            }
        })).then(cards => {
            cards.filter(Boolean).forEach(card => grid.appendChild(card));
            dlcList.appendChild(grid);
            this.closeModal('gameModal');
            this.showModal('dlcModal');
            if (selectAllCheckbox) {
                selectAllCheckbox.checked = false;
                selectAllCheckbox.onchange = () => {
                    const allCheckboxes = grid.querySelectorAll('.dlc-select-checkbox');
                    allCheckboxes.forEach(cb => {
                        cb.checked = selectAllCheckbox.checked;
                        if (cb.checked) {
                            selectedDLCs.add(cb.value);
                        } else {
                            selectedDLCs.delete(cb.value);
                        }
                    });
                };
            }
            const confirmBtn = document.getElementById('confirmDLCBtn');
            const cancelBtn = document.getElementById('cancelDLCBtn');
            if (confirmBtn) {
                confirmBtn.onclick = () => {
                    this.confirmGameWithDLCs(gameDetails.appid, Array.from(selectedDLCs));
                };
            }
            if (cancelBtn) {
                cancelBtn.onclick = () => {
                    // Kullanıcı DLC modalını kapatırsa ana oyun yine de eklensin
                    this.confirmGameWithDLCs(gameDetails.appid, []);
                    this.closeModal('dlcModal');
                };
            }
        });
    }

    showSteamRestartDialog() {
        this.showModal('steamRestartModal');
        this.startRestartCountdown();
    }

    startRestartCountdown() {
        let seconds = 5;
        const countdownElement = document.getElementById('countdown');
        
        this.restartCountdown = setInterval(() => {
            countdownElement.textContent = seconds;
            seconds--;
            
            if (seconds < 0) {
                clearInterval(this.restartCountdown);
                this.restartSteam();
            }
        }, 1000);
    }

    async restartSteam() {
        if (this.restartCountdown) {
            clearInterval(this.restartCountdown);
        }
        
        try {
            await ipcRenderer.invoke('restart-steam');
            this.showNotification('Başarılı', 'Steam yeniden başlatılıyor', 'success');
            this.closeModal('steamRestartModal');
        } catch (error) {
            console.error('Failed to restart Steam:', error);
            this.showNotification('Hata', 'Steam yeniden başlatılamadı', 'error');
        }
    }

    async loadLibrary() {
        try {
            this.libraryGames = await ipcRenderer.invoke('get-library-games');
            if (!Array.isArray(this.libraryGames)) {
                this.libraryGames = [];
            }
            this.renderLibrary();
        } catch (error) {
            console.error('Failed to load library:', error);
            this.libraryGames = [];
            this.renderLibrary();
            this.showNotification('Hata', 'Kütüphane yüklenemedi', 'error');
        }
    }

    async refreshLibrary() {
        const refreshBtn = document.getElementById('refreshLibraryBtn');
        if (refreshBtn) {
            refreshBtn.classList.add('loading');
        }
        
        try {
            this.showNotification('info', 'refreshing_library', 'info');
            this.libraryGames = await ipcRenderer.invoke('get-library-games');
            this.renderLibrary();
            this.showNotification('success', 'library_refreshed', 'success');
        } catch (error) {
            console.error('Failed to refresh library:', error);
            this.showNotification('error', 'library_refresh_failed', 'error');
        } finally {
            if (refreshBtn) {
                refreshBtn.classList.remove('loading');
            }
        }
    }

    renderLibrary() {
        const libraryGrid = document.getElementById('libraryGrid');
        const libraryCount = document.getElementById('libraryCount');
        libraryCount.textContent = this.libraryGames.length;
        libraryGrid.innerHTML = '';

        if (this.libraryGames.length === 0) {
            libraryGrid.innerHTML = '<div class="no-games">Kütüphanenizde henüz oyun yok</div>';
            return;
        }

        // Kütüphane oyunlarını asenkron olarak oluştur
        const createLibraryCards = async () => {
            for (const game of this.libraryGames) {
                try {
                    const gameCard = await this.createGameCard(game, true); // kütüphane için ikinci parametre true
                    if (gameCard) {
                        libraryGrid.appendChild(gameCard);
                    }
                } catch (error) {
                    console.error('Game card creation failed:', error);
                }
            }
        };
        
        createLibraryCards();
    }

    openSteamPage(appId) {
        ipcRenderer.invoke('open-external', `https://store.steampowered.com/app/${appId}`);
    }

    async loadMoreGames() {
        const cc = this.countryCode || 'TR';
        const lang = this.getSelectedLang();
        this.showLoading();
        try {
            // Popüler oyunları Steam'den çek
            const offset = this.gamesData.length;
            const resultsUrl = `https://store.steampowered.com/search/results?sort_by=Reviews_DESC&category1=998&force_infinite=1&start=${offset}&count=11&supportedlang=turkish&ndl=1&snr=1_7_7_151_7`;
            const html = await (await safeSteamFetch(resultsUrl)).text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const rows = doc.querySelectorAll('.search_result_row');
            // Her oyun için detay çek
            const newGamesRaw = Array.from(rows).map(row => {
                const appid = row.getAttribute('data-ds-appid');
                const name = row.querySelector('.title')?.textContent?.trim() || '';
                return { appid, name };
            });
            // Aynı oyun tekrar eklenmesin
            const existingAppIds = new Set(this.gamesData.map(g => String(g.appid)));
            const filteredGames = newGamesRaw.filter(g => !existingAppIds.has(String(g.appid)));
            // Her oyun için detaylı veri çek
            const newGames = await Promise.all(filteredGames.slice(0, 11).map(async g => {
                try {
                    const gameData = await fetchSteamAppDetails(g.appid, cc, lang);
                    if (!gameData) return null;
                    return {
                        appid: g.appid,
                        name: gameData.name,
                        header_image: gameData.header_image,
                        price: gameData.price_overview ? gameData.price_overview.final : 0,
                        discount_percent: gameData.price_overview ? gameData.price_overview.discount_percent : 0,
                        platforms: gameData.platforms,
                        coming_soon: gameData.release_date?.coming_soon,
                        tags: [],
                        short_description: gameData.short_description,
                        reviews: gameData.recommendations ? 'Çok Olumlu' : '',
                        is_dlc: false
                    };
                } catch {
                    return null;
                }
            }));
            this.gamesData = this.gamesData.concat(newGames.filter(Boolean));
            this.renderGames();
            this.updateHeroSection();
        } finally {
            this.hideLoading();
        }
    }

    async loadMoreAllGames() {
        const cc = this.countryCode || 'TR';
        const lang = this.getSelectedLang();
        this.showLoading();
        try {
            // Popüler oyunları Steam'den çek
            const offset = this.gamesData.length;
            const resultsUrl = `https://store.steampowered.com/search/results?sort_by=Reviews_DESC&category1=998&force_infinite=1&start=${offset}&count=20&supportedlang=turkish&ndl=1&snr=1_7_7_151_7`;
            const html = await (await safeSteamFetch(resultsUrl)).text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const rows = doc.querySelectorAll('.search_result_row');
            // Her oyun için detay çek
            const newGamesRaw = Array.from(rows).map(row => {
                const appid = row.getAttribute('data-ds-appid');
                const name = row.querySelector('.title')?.textContent?.trim() || '';
                return { appid, name };
            });
            // Aynı oyun tekrar eklenmesin
            const existingAppIds = new Set(this.gamesData.map(g => String(g.appid)));
            const filteredGames = newGamesRaw.filter(g => !existingAppIds.has(String(g.appid)));
            // Her oyun için detaylı veri çek
            const newGames = await Promise.all(filteredGames.slice(0, 20).map(async g => {
                try {
                    const gameData = await fetchSteamAppDetails(g.appid, cc, lang);
                    if (!gameData) return null;
                    return {
                        appid: g.appid,
                        name: gameData.name,
                        header_image: gameData.header_image,
                        price: gameData.price_overview ? gameData.price_overview : 0,
                        price_overview: gameData.price_overview,
                        discount_percent: gameData.price_overview ? gameData.price_overview.discount_percent : 0,
                        platforms: gameData.platforms,
                        coming_soon: gameData.release_date?.coming_soon,
                        tags: [],
                        genres: gameData.genres || [],
                        short_description: gameData.short_description,
                        reviews: gameData.recommendations ? 'Çok Olumlu' : '',
                        metacritic: gameData.metacritic,
                        release_date: gameData.release_date,
                        is_dlc: false
                    };
                } catch (error) {
                    console.error(`Failed to load game ${g.appid}:`, error);
                    return null;
                }
            }));
            this.gamesData = this.gamesData.concat(newGames.filter(Boolean));
            this.filteredAllGames = [...this.gamesData];
            this.sortAllGames();
            this.renderFilteredAllGames();
            this.updateAllGamesFilterResults();
        } catch (error) {
            console.error('Failed to load more all games:', error);
            this.showNotification('Hata', 'Oyunlar yüklenemedi', 'error');
        } finally {
            this.hideLoading();
        }
    }

    showModal(modalId) {
        const modal = document.getElementById(modalId);
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
    }

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        modal.classList.remove('active');
        document.body.style.overflow = 'auto';
        
        if (modalId === 'steamRestartModal' && this.restartCountdown) {
            clearInterval(this.restartCountdown);
        }
        // Oyun detay modalı kapatılırken state temizle
        if (modalId === 'gameModal') {
            this.clearGameModalState();
        }
    }

    closeAllModals() {
        document.querySelectorAll('.modal-overlay').forEach(modal => {
            modal.classList.remove('active');
        });
        document.body.style.overflow = 'auto';
        
        if (this.restartCountdown) {
            clearInterval(this.restartCountdown);
        }
    }

    showLoading() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.classList.add('active');
            overlay.style.display = 'flex';
        }
        const loadingText = document.querySelector('.loading-text');
        if (loadingText) loadingText.textContent = this.translate('loading_games');
    }

    hideLoading() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.classList.remove('active');
            overlay.style.display = 'none';
        }
    }

    showNotification(title, message, type = 'info') {
        // Bildirim başlık ve mesajını çeviriyle göster
        const notifTitle = this.translate(title) || title;
        const notifMsg = this.translate(message) || message;
        const notification = document.createElement('div');
        notification.className = `notification ${type}`;
        notification.innerHTML = `
            <div class="notification-title">${notifTitle}</div>
            <div class="notification-message">${notifMsg}</div>
        `;
        document.getElementById('notificationContainer').appendChild(notification);
        setTimeout(() => {
            notification.remove();
        }, 3500);
    }

    launchGame(appId) {
        // Steam'de oyunu başlat
        ipcRenderer.invoke('open-external', `steam://run/${appId}`);
        this.showNotification('success', 'Oyun Steam üzerinden başlatılıyor...', 'success');
    }

    async getGameImageUrl(appId, gameName) {
        try {
            // Öncelik: header.jpg
            const candidates = [
                `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
                `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/capsule_616x353.jpg`,
                `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_600x900.jpg`,
                `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_hero.jpg`
            ];

            for (const url of candidates) {
                try {
                    const resp = await fetch(url, { method: 'HEAD' });
                    if (resp.ok) return url;
                } catch {}
            }
            return 'pdbanner.png';
        } catch {
            return 'pdbanner.png';
        }
    }

    async deleteGame(appId) {
        this.showLoading();
        try {
            const result = await ipcRenderer.invoke('delete-game', appId);
            if (result.success) {
                this.showNotification('success', 'game_deleted', 'success');
                await this.loadLibrary();
            } else {
                this.showNotification('error', result.error || 'game_delete_failed', 'error');
            }
        } catch (error) {
            this.showNotification('error', 'game_delete_failed', 'error');
        } finally {
            this.hideLoading();
        }
    }

    // handleSearch fonksiyonunu güncelle: enterPressed parametresi ekle
    handleSearch(query, enterPressed = false) {
        const cc = this.countryCode || 'TR';
        const lang = this.getSelectedLang();
        const heroSection = document.getElementById('heroSection');
        const currentPage = this.getCurrentPage();
        
        // Online Pass sayfasında arama
        if (currentPage === 'onlinePass') {
            this.handleOnlinePassSearch(query);
            return;
        }
        
        if (!enterPressed && (!query || query.length < 2)) {
            this.loadGames();
            if (heroSection) heroSection.style.display = '';
            // Geri Dön butonunu kaldır
            const backBtn = document.getElementById('searchBackBtn');
            if (backBtn) backBtn.remove();
            return;
        }
        if (this.searchTimeout) {
            clearTimeout(this.searchTimeout);
        }
        this.searchTimeout = setTimeout(async () => {
            const gamesGrid = document.getElementById('gamesGrid');
            // Geri Dön butonunu ekle
            let backBtn = document.getElementById('searchBackBtn');
            if (!backBtn) {
                backBtn = document.createElement('button');
                backBtn.id = 'searchBackBtn';
                backBtn.className = 'back-btn';
                backBtn.innerText = '⟵ Geri Dön';
                backBtn.style = 'margin-bottom: 16px; margin-left: 8px; font-size: 16px; padding: 6px 18px; border-radius: 8px; background: #222; color: #fff; border: none; cursor: pointer;';
                backBtn.onclick = () => {
                    this.loadGames();
                    if (heroSection) heroSection.style.display = '';
                    backBtn.remove();
                };
                // gamesGrid'in üstüne ekle
                gamesGrid.parentNode.insertBefore(backBtn, gamesGrid);
            }
            if (query.trim()) {
                this.showLoading();
                gamesGrid.innerHTML = '<div class="no-games">Aranıyor...';
                if (heroSection) heroSection.style.display = 'none';
                try {
                    let games = [];
                    if (/^\d+$/.test(query.trim())) {
                        // Appid ile arama
                        const url = `https://store.steampowered.com/api/appdetails?appids=${query.trim()}&cc=${cc}&l=${lang}`;
                        const res = await fetch(url);
                        const data = await res.json();
                        const gameData = data[query.trim()]?.data;
                        if (!gameData) throw new Error('Oyun bulunamadı');
                        games = [{
                            appid: query.trim(),
                            name: gameData.name,
                            header_image: gameData.header_image,
                            price: gameData.price_overview ? gameData.price_overview.final : 0,
                            discount_percent: gameData.price_overview ? gameData.price_overview.discount_percent : 0,
                            platforms: gameData.platforms,
                            coming_soon: gameData.release_date?.coming_soon,
                            short_description: gameData.short_description,
                            reviews: gameData.recommendations ? 'Çok Olumlu' : '',
                            is_dlc: false
                        }];
                    } else {
                        // Steam search results endpoint ile isimle arama
                        const searchTerm = encodeURIComponent(query.trim());
                        const resultsUrl = `https://store.steampowered.com/search/results?term=${searchTerm}&force_infinite=1&supportedlang=turkish&ndl=1&snr=1_7_7_151_7`;
                        const html = await (await fetch(resultsUrl)).text();
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(html, 'text/html');
                        const rows = doc.querySelectorAll('.search_result_row');
                        // Her oyun için ayrıca header_image çek
                        const gamesRaw = Array.from(rows).map(row => {
                            const appid = row.getAttribute('data-ds-appid');
                            const name = row.querySelector('.title')?.textContent?.trim() || '';
                            const priceEl = row.querySelector('.search_price');
                            let price = 0;
                            let discount_percent = 0;
                            if (priceEl) {
                                const priceText = priceEl.textContent.replace(/\n/g, '').replace(/\s+/g, ' ').trim();
                                const match = priceText.match(/([\d,.]+) TL/);
                                if (match) price = parseFloat(match[1].replace(',', '.')) * 100;
                                const discountEl = row.querySelector('.search_discount span');
                                if (discountEl) discount_percent = parseInt(discountEl.textContent.replace('%', '').replace('-', ''));
                            }
                            return {
                                appid,
                                name,
                                price,
                                discount_percent
                            };
                        });
                        // Her oyun için header_image çek
                        games = await Promise.all(gamesRaw.map(async g => {
                            try {
                                const detailRes = await fetch(`https://store.steampowered.com/api/appdetails?appids=${g.appid}&cc=${cc}&l=${lang}`);
                                const detailData = await detailRes.json();
                                const gameData = detailData[g.appid]?.data;
                                let header_image = gameData?.header_image;
                                if (!header_image) {
                                    header_image = `https://cdn.akamai.steamstatic.com/steam/apps/${g.appid}/capsule_616x353.jpg`;
                                }
                                return {
                                    appid: g.appid,
                                    name: g.name,
                                    header_image,
                                    price: g.price,
                                    discount_percent: g.discount_percent,
                                    platforms: {},
                                    coming_soon: false,
                                    tags: [],
                                    short_description: gameData?.short_description || '',
                                    reviews: '',
                                    is_dlc: false
                                };
                            } catch {
                                return null;
                            }
                        }));
                        if (!games.length) throw new Error('Oyun bulunamadı');
                    }
                    this.gamesData = games.filter(Boolean);
                    this.renderGames();
                } catch (error) {
                    let msg = error.message || 'Arama yapılamadı';
                    gamesGrid.innerHTML = `<div class=\"no-games\">${msg}</div>`;
                    this.showNotification('Hata', msg, 'error');
                    console.error('Arama hatası:', error);
                } finally {
                    this.hideLoading();
                }
            } else {
                this.loadGames();
                if (heroSection) heroSection.style.display = '';
            }
        }, 400);
    }

    // Basit çeviri sözlüğü ve translate fonksiyonu
    getSelectedLang() {
        return localStorage.getItem('selectedLang') || 'tr';
    }
    translate(key) {
        const lang = this.getSelectedLang();
        const dict = {
            'library': {
                tr: 'Kütüphanem', en: 'Library', de: 'Bibliothek', fr: 'Bibliothèque', es: 'Biblioteca', ru: 'Библиотека', zh: '库', ja: 'ライブラリ', it: 'Libreria', pt: 'Biblioteca', ko: '라이브러리', ar: 'المكتبة', az: 'Kitabxanam'
            },
            'settings': {
                tr: 'Ayarlar', en: 'Settings', de: 'Einstellungen', fr: 'Paramètres', es: 'Configuración', ru: 'Настройки', zh: '设置', ja: '設定', it: 'Impostazioni', pt: 'Configurações', ko: '설정', ar: 'الإعدادات', az: 'Parametrlər'
            },
            'online_pass': {
                tr: 'Online Pass', en: 'Online Pass', de: 'Online Pass', fr: 'Online Pass', es: 'Online Pass', ru: 'Online Pass', zh: '在线通行证', ja: 'オンラインパス', it: 'Online Pass', pt: 'Online Pass', ko: '온라인 패스', ar: 'المرور الإلكتروني', az: 'Onlayn Pas'
            },
            'online_add': {
                tr: 'Online Ekle', en: 'Add Online', de: 'Online hinzufügen', fr: 'Ajouter en ligne', es: 'Añadir en línea', ru: 'Добавить онлайн', zh: '在线添加', ja: 'オンライン追加', it: 'Aggiungi online', pt: 'Adicionar online', ko: '온라인 추가', ar: 'إضافة عبر الإنترنت', az: 'Onlayn Əlavə Et'
            },
            'game_id': {
                tr: 'Oyun ID', en: 'Game ID', de: 'Spiel-ID', fr: 'ID du jeu', es: 'ID del juego', ru: 'ID игры', zh: '游戏ID', ja: 'ゲームID', it: 'ID gioco', pt: 'ID do jogo', ko: '게임 ID', ar: 'معرف اللعبة', az: 'Oyun ID'
            },
            'online_games_loading': {
                tr: 'Yükleniyor...', en: 'Loading...', de: 'Lädt...', fr: 'Chargement...', es: 'Cargando...', ru: 'Загрузка...', zh: '加载中...', ja: '読み込み中...', it: 'Caricamento...', pt: 'Carregando...', ko: '로딩 중...', ar: 'جاري التحميل...', az: 'Yüklənir...'
            },
            'online_games_load_failed': {
                tr: 'Online oyunlar yüklenemedi', en: 'Failed to load online games', de: 'Online Spiele konnten nicht geladen werden', fr: 'Échec du chargement des jeux en ligne', es: 'No se pudieron cargar los juegos en línea', ru: 'Не удалось загрузить онлайн игры', zh: '无法加载在线游戏', ja: 'オンラインゲームの読み込みに失敗しました', it: 'Impossibile caricare i giochi online', pt: 'Falha ao carregar jogos online', ko: '온라인 게임 로딩 실패', ar: 'فشل في تحميل الألعاب الإلكترونية', az: 'Onlayn oyunlar yüklənə bilmədi'
            },
            'search_placeholder': {
                tr: 'Oyun ara...', en: 'Search game...', de: 'Spiel suchen...', fr: 'Rechercher un jeu...', es: 'Buscar juego...', ru: 'Поиск игры...', zh: '搜索游戏...', ja: 'ゲーム検索...', it: 'Cerca gioco...', pt: 'Buscar jogo...', ko: '게임 검색...', ar: 'ابحث عن لعبة...', az: 'Oyun axtar...'
            },
            'add_to_library': {
                tr: 'Kütüphaneme Ekle', en: 'Add to Library', de: 'Zur Bibliothek', fr: 'Ajouter à la bibliothèque', es: 'Añadir a la biblioteca', ru: 'Добавить в библиотеку', zh: '添加到库', ja: 'ライブラリに追加', it: 'Aggiungi alla libreria', pt: 'Adicionar à biblioteca', ko: '라이브러리에 추가', ar: 'أضف إلى المكتبة', az: 'Kitabxanaya əlavə et'
            },
            'already_in_library': {
                tr: 'Zaten Sahipsiniz', en: 'Already Owned', de: 'Bereits vorhanden', fr: 'Déjà possédé', es: 'Ya en tu biblioteca', ru: 'Уже есть', zh: '已拥有', ja: 'すでに所有', it: 'Già posseduto', pt: 'Já possui', ko: '이미 보유', ar: 'موجود بالفعل', az: 'Artıq sahibsiniz'
            },
            'launch_game': {
                tr: 'Oyunu Başlat', en: 'Launch Game', de: 'Spiel starten', fr: 'Lancer le jeu', es: 'Iniciar juego', ru: 'Запустить игру', zh: '启动游戏', ja: 'ゲーム開始', it: 'Avvia gioco', pt: 'Iniciar jogo', ko: '게임 시작', ar: 'تشغيل اللعبة', az: 'Oyunu başlat'
            },
            'delete_game': {
                tr: 'Oyunu Sil', en: 'Delete Game', de: 'Spiel löschen', fr: 'Supprimer le jeu', es: 'Eliminar juego', ru: 'Удалить игру', zh: '删除游戏', ja: 'ゲーム削除', it: 'Elimina gioco', pt: 'Excluir jogo', ko: '게임 삭제', ar: 'حذف اللعبة', az: 'Oyunu sil'
            },
            'view_details': {
                tr: 'Detayları Görüntüle', en: 'View Details', de: 'Details anzeigen', fr: 'Voir les détails', es: 'Ver detalles', ru: 'Подробнее', zh: '查看详情', ja: '詳細を見る', it: 'Vedi dettagli', pt: 'Ver detalhes', ko: '상세 보기', ar: 'عرض التفاصيل', az: 'Təfərrüatları göstər'
            },
            'free': {
                tr: 'Ücretsiz', en: 'Free', de: 'Kostenlos', fr: 'Gratuit', es: 'Gratis', ru: 'Бесплатно', zh: '免费', ja: '無料', it: 'Gratis', pt: 'Grátis', ko: '무료', ar: 'مجاني', az: 'Pulsuz'
            },
            'discount': {
                tr: 'İndirim', en: 'Discount', de: 'Rabatt', fr: 'Remise', es: 'Descuento', ru: 'Скидка', zh: '折扣', ja: '割引', it: 'Sconto', pt: 'Desconto', ko: '할인', ar: 'خصم', az: 'Endirim'
            },
            'game_not_found': {
                tr: 'Oyun bulunamadı', en: 'Game not found', de: 'Spiel nicht gefunden', fr: 'Jeu introuvable', es: 'Juego no encontrado', ru: 'Игра не найдена', zh: '未找到游戏', ja: 'ゲームが見つかりません', it: 'Gioco non trovato', pt: 'Jogo não encontrado', ko: '게임을 찾을 수 없음', ar: 'اللعبة غير موجودة', az: 'Oyun tapılmadı'
            },
            'success': {
                tr: 'Başarılı', en: 'Success', de: 'Erfolg', fr: 'Succès', es: 'Éxito', ru: 'Успешно', zh: '成功', ja: '成功', it: 'Successo', pt: 'Sucesso', ko: '성공', ar: 'نجاح', az: 'Uğurlu'
            },
            'error': {
                tr: 'Hata', en: 'Error', de: 'Fehler', fr: 'Erreur', es: 'Error', ru: 'Ошибка', zh: '错误', ja: 'エラー', it: 'Errore', pt: 'Erro', ko: '오류', ar: 'خطأ', az: 'Xəta'
            },
            'game_added': {
                tr: 'Oyun kütüphanene eklendi', en: 'Game added to your library', de: 'Spiel zur Bibliothek hinzugefügt', fr: 'Jeu ajouté à votre bibliothèque', es: 'Juego añadido a tu biblioteca', ru: 'Игра добавлена в библиотеку', zh: '已添加到库', ja: 'ライブラリに追加されました', it: 'Gioco aggiunto alla libreria', pt: 'Jogo adicionado à biblioteca', ko: '라이브러리에 추가됨', ar: 'تمت إضافة اللعبة إلى مكتبتك', az: 'Oyun kitabxananıza əlavə edildi'
            },
            'game_add_failed': {
                tr: 'Oyun kütüphaneye eklenemedi', en: 'Failed to add game', de: 'Spiel konnte nicht hinzugefügt werden', fr: 'Échec de l\'ajout du jeu', es: 'No se pudo añadir el juego', ru: 'Не удалось добавить игру', zh: '无法添加游戏', ja: 'ゲームを追加できませんでした', it: 'Impossibile aggiungere il gioco', pt: 'Falha ao adicionar o jogo', ko: '게임 추가 실패', ar: 'فشل في إضافة اللعبة', az: 'Oyun kitabxanaya əlavə edilə bilmədi'
            },
            'load_more': {
                tr: 'Daha fazla oyun yükle', en: 'Load more games', de: 'Mehr Spiele laden', fr: 'Charger plus de jeux', es: 'Cargar más juegos', ru: 'Загрузить больше игр', zh: '加载更多游戏', ja: 'さらにゲームを読み込む', it: 'Carica altri giochi', pt: 'Carregar mais jogos', ko: '더 많은 게임 불러오기', ar: 'تحميل المزيد من الألعاب', az: 'Daha çox oyun yüklə'
            },
            'searching': {
                tr: 'Aranıyor...', en: 'Searching...', de: 'Wird gesucht...', fr: 'Recherche...', es: 'Buscando...', ru: 'Поиск...', zh: '搜索中...', ja: '検索中...', it: 'Ricerca...', pt: 'Pesquisando...', ko: '검색 중...', ar: 'يتم البحث...', az: 'Axtarılır...'
            },
            'no_results': {
                tr: 'Sonuç bulunamadı', en: 'No results found', de: 'Keine Ergebnisse gefunden', fr: 'Aucun résultat trouvé', es: 'No se encontraron resultados', ru: 'Результаты не найдены', zh: '未找到结果', ja: '結果が見つかりません', it: 'Nessun risultato trovato', pt: 'Nenhum resultado encontrado', ko: '결과 없음', ar: 'لم يتم العثور على نتائج', az: 'Nəticə tapılmadı'
            },
            'no_games': {
                tr: 'Hiç oyun bulunamadı', en: 'No games found', de: 'Keine Spiele gefunden', fr: 'Aucun jeu trouvé', es: 'No se encontraron juegos', ru: 'Игры не найдены', zh: '未找到游戏', ja: 'ゲームが見つかりません', it: 'Nessun gioco trovato', pt: 'Nenhum jogo encontrado', ko: '게임 없음', ar: 'لم يتم العثور على ألعاب', az: 'Heç bir oyun tapılmadı'
            },
            'no_library_games': {
                tr: 'Kütüphanenizde henüz oyun yok', en: 'No games in your library yet', de: 'Noch keine Spiele in der Bibliothek', fr: 'Aucun jeu dans votre bibliothèque', es: 'Aún no hay juegos en tu biblioteca', ru: 'В вашей библиотеке пока нет игр', zh: '您的库中还没有游戏', ja: 'ライブラリにまだゲームがありません', it: 'Nessun gioco nella tua libreria', pt: 'Ainda não há jogos na sua biblioteca', ko: '아직 라이브러리에 게임이 없습니다', ar: 'لا توجد ألعاب في مكتبتك بعد', az: 'Kitabxananızda hələ oyun yoxdur'
            },
            'no_description': {
                tr: 'Açıklama bulunamadı', en: 'No description found', de: 'Keine Beschreibung gefunden', fr: 'Aucune description trouvée', es: 'No se encontró descripción', ru: 'Описание не найдено', zh: '未找到描述', ja: '説明が見つかりません', it: 'Nessuna descrizione trovata', pt: 'Nenhuma descrição encontrada', ko: '설명 없음', ar: 'لم يتم العثور على وصف', az: 'Təsvir tapılmadı'
            },
            'very_positive': {
                tr: 'Çok Olumlu', en: 'Very Positive', de: 'Sehr positiv', fr: 'Très positif', es: 'Muy positivo', ru: 'Очень положительно', zh: '特别好评', ja: '非常に好評', it: 'Molto positivo', pt: 'Muito positivo', ko: '매우 긍정적', ar: 'إيجابي جدًا', az: 'Çox müsbət'
            },
            'mixed': {
                tr: 'Karışık', en: 'Mixed', de: 'Gemischt', fr: 'Mitigé', es: 'Mixto', ru: 'Смешанные', zh: '褒贬不一', ja: '賛否両論', it: 'Misto', pt: 'Misto', ko: '복합적', ar: 'مختلط', az: 'Qarışıq'
            },
            'home': {
                tr: 'Ana Sayfa', en: 'Home', de: 'Startseite', fr: 'Accueil', es: 'Inicio', ru: 'Главная', zh: '首页', ja: 'ホーム', it: 'Home', pt: 'Início', ko: '홈', ar: 'الرئيسية', az: 'Ana Səhifə'
            },
            'library_tab': {
                tr: 'Kütüphane', en: 'Library', de: 'Bibliothek', fr: 'Bibliothèque', es: 'Biblioteca', ru: 'Библиотека', zh: '库', ja: 'ライブラリ', it: 'Libreria', pt: 'Biblioteca', ko: '라이브러리', ar: 'المكتبة', az: 'Kitabxana'
            },
            'settings_tab': {
                tr: 'Ayarlar', en: 'Settings', de: 'Einstellungen', fr: 'Paramètres', es: 'Configuración', ru: 'Настройки', zh: '设置', ja: '設定', it: 'Impostazioni', pt: 'Configurações', ko: '설정', ar: 'الإعدادات', az: 'Parametrlər'
            },
            'start_game': {
                tr: 'Oyunu Başlat', en: 'Launch Game', de: 'Spiel starten', fr: 'Lancer le jeu', es: 'Iniciar juego', ru: 'Запустить игру', zh: '启动游戏', ja: 'ゲーム開始', it: 'Avvia gioco', pt: 'Iniciar jogo', ko: '게임 시작', ar: 'تشغيل اللعبة', az: 'Oyunu başlat'
            },
            'remove_game': {
                tr: 'Oyunu Sil', en: 'Delete Game', de: 'Spiel löschen', fr: 'Supprimer le jeu', es: 'Eliminar juego', ru: 'Удалить игру', zh: '删除游戏', ja: 'ゲーム削除', it: 'Elimina gioco', pt: 'Excluir jogo', ko: '게임 삭제', ar: 'حذف اللعبة', az: 'Oyunu sil'
            },
            'already_added': {
                tr: 'Zaten Sahipsiniz', en: 'Already Owned', de: 'Bereits vorhanden', fr: 'Déjà possédé', es: 'Ya en tu biblioteca', ru: 'Уже есть', zh: '已拥有', ja: 'すでに所有', it: 'Già posseduto', pt: 'Já possui', ko: '이미 보유', ar: 'موجود بالفعل', az: 'Artıq sahibsiniz'
            },
            'featured_game': {
                tr: 'Öne Çıkan Oyun', en: 'Featured Game', de: 'Vorgestelltes Spiel', fr: 'Jeu présenté', es: 'Juego destacado', ru: 'Рекомендуемое игровое программное обеспечение', zh: '推荐游戏', ja: 'おすすめゲーム', it: 'Gioco in evidenza', pt: 'Jogo em destaque', ko: '추천 게임', ar: 'اللعبة الموصى بها', az: 'Seçilmiş Oyun'
            },
            'loading': {
                tr: 'Yükleniyor...', en: 'Loading...', de: 'Lädt...', fr: 'Chargement...', es: 'Cargando...', ru: 'Загрузка...', zh: '加载中...', ja: '読み込み中...', it: 'Caricamento...', pt: 'Carregando...', ko: '로딩 중...', ar: 'جاري التحميل...', az: 'Yüklənir...'
            },
            'discovering_games': {
                tr: 'Harika oyunlar keşfediliyor...', en: 'Discovering great games...', de: 'Entdecken Sie großartige Spiele...', fr: 'Découvrez de superbes jeux...', es: 'Descubriendo juegos geniales...', ru: 'Открываем замечательные игры...', zh: '发现精彩游戏...', ja: '素晴らしいゲームを発見中...', it: 'Scopri giochi fantastici...', pt: 'Descobrindo jogos incríveis...', ko: '멋진 게임을 발견 중...', ar: 'جاري اكتشاف الألعاب الرائعة...', az: 'Əla oyunlar kəşf edilir...'
            },
            'price': {
                tr: 'Fiyat', en: 'Price', de: 'Preis', fr: 'Prix', es: 'Precio', ru: 'Цена', zh: '价格', ja: '価格', it: 'Prezzo', pt: 'Preço', ko: '가격', ar: 'السعر', az: 'Qiymət'
            },
            'featured_games': {
                tr: 'Öne Çıkan Oyunlar', en: 'Featured Games', de: 'Vorgestellte Spiele', fr: 'Jeux présentés', es: 'Juegos destacados', ru: 'Рекомендуемые игры', zh: '推荐游戏', ja: 'おすすめゲーム', it: 'Giocchi in evidenza', pt: 'Jogos em destaque', ko: '추천 게임', ar: 'الألعاب الموصى بها', az: 'Seçilmiş Oyunlar'
            },
            'steam_page': {
                tr: 'Steam Sayfası', en: 'Steam Page', de: 'Steam Seite', fr: 'Page Steam', es: 'Página de Steam', ru: 'Страница Steam', zh: 'Steam页面', ja: 'Steamページ', it: 'Pagina Steam', pt: 'Página Steam', ko: 'Steam 페이지', ar: 'صفحة Steam', az: 'Steam Səhifəsi'
            },
            'steam_config': {
                tr: 'Steam Yapılandırması', en: 'Steam Configuration', de: 'Steam-Konfiguration', fr: 'Configuration Steam', es: 'Configuración de Steam', ru: 'Настройка Steam', zh: 'Steam设置', ja: 'Steam設定', it: 'Configurazione Steam', pt: 'Configuração Steam', ko: 'Steam 설정', pl: 'Konfiguracja Steam', az: 'Steam Konfiqurasiyası'
            },
            'steam_path': {
                tr: 'Steam Kurulum Yolu:', en: 'Steam Install Path:', de: 'Steam Installationspfad:', fr: 'Chemin d\'installation Steam:', es: 'Ruta de instalación de Steam:', ru: 'Путь установки Steam:', zh: 'Steam安装路径:', ja: 'Steamインストールパス:', it: 'Percorso di installazione Steam:', pt: 'Caminho de instalação do Steam:', ko: 'Steam 설치 경로:', pl: 'Ścieżka instalacji Steam:', az: 'Steam Quraşdırma Yolu:'
            },
            'steam_path_placeholder': {
                tr: 'Yüklü Steam dizini', en: 'Installed Steam directory', de: 'Installiertes Steam-Verzeichnis', fr: 'Répertoire Steam installé', es: 'Directorio de Steam instalado', ru: 'Установленный каталог Steam', zh: '已安装的Steam目录', ja: 'インストール済みのSteamディレクトリ', it: 'Directory Steam installata', pt: 'Diretório Steam instalado', ko: '설치된 Steam 디렉토리', pl: 'Zainstalowany katalog Steam', az: 'Quraşdırılmış Steam qovluğu'
            },
            'browse': {
                tr: 'Gözat', en: 'Browse', de: 'Durchsuchen', fr: 'Parcourir', es: 'Examinar', ru: 'Обзор', zh: '浏览', ja: '参照', it: 'Sfoglia', pt: 'Procurar', ko: '찾아보기', pl: 'Przeglądaj', az: 'Gözdən keçir'
            },
            'app_settings': {
                tr: 'Uygulama Ayarları', en: 'App Settings', de: 'App-Einstellungen', fr: 'Paramètres de l\'application', es: 'Configuración de la aplicación', ru: 'Настройки приложения', zh: '应用设置', ja: 'アプリ設定', it: 'Impostazioni app', pt: 'Configurações do aplicativo', ko: '앱 설정', pl: 'Ustawienia aplikacji', az: 'Tətbiq Parametrləri'
            },
            'enable_discord': {
                tr: 'Discord Rich Presence\'ı Etkinleştir', en: 'Enable Discord Rich Presence', de: 'Discord Rich Presence aktivieren', fr: 'Activer Discord Rich Presence', es: 'Activar Discord Rich Presence', ru: 'Включить Discord Rich Presence', zh: '启用Discord Rich Presence', ja: 'Discord Rich Presenceを有効にする', it: 'Abilita Discord Rich Presence', pt: 'Ativar Discord Rich Presence', ko: 'Discord Rich Presence 활성화', pl: 'Włącz Discord Rich Presence', az: 'Discord Rich Presence-i Aktivləşdir'
            },
            'enable_animations': {
                tr: 'Animasyonları Etkinleştir', en: 'Enable Animations', de: 'Animationen aktivieren', fr: 'Activer les animations', es: 'Activar animaciones', ru: 'Включить анимации', zh: '启用动画', ja: 'アニメーションを有効にする', it: 'Abilita animazioni', pt: 'Ativar animações', ko: '애니메이션 활성화', pl: 'Włącz animacje', az: 'Animasiyaları Aktivləşdir'
            },
            'enable_sounds': {
                tr: 'Ses Efektlerini Etkinleştir', en: 'Enable Sound Effects', de: 'Soundeffekte aktivieren', fr: 'Activer les effets sonores', es: 'Activar efectos de sonido', ru: 'Включить звуковые эффекты', zh: '启用音效', ja: '効果音を有効にする', it: 'Abilita effetti sonori', pt: 'Ativar efeitos sonoros', ko: '사운드 효과 활성화', pl: 'Włącz efekty dźwiękowe', az: 'Səs Effektlərini Aktivləşdir'
            },
            'game_title': {
                tr: 'Oyun Adı', en: 'Game Title', de: 'Spieltitel', fr: 'Titre du jeu', es: 'Título del juego', ru: 'Название игры', zh: '游戏名称', ja: 'ゲームタイトル', it: 'Titolo del gioco', pt: 'Título do jogo', ko: '게임 제목', pl: 'Tytuł gry', az: 'Oyun Adı'
            },
            'developer': {
                tr: 'Geliştirici', en: 'Developer', de: 'Entwickler', fr: 'Développeur', es: 'Desarrollador', ru: 'Разработчик', zh: '开发者', ja: '開発者', it: 'Sviluppatore', pt: 'Desenvolvedor', ko: '개발자', pl: 'Deweloper', az: 'İnkişafçı'
            },
            'release_year': {
                tr: 'Yıl', en: 'Year', de: 'Jahr', fr: 'Année', es: 'Año', ru: 'Год', zh: '年份', ja: '年', it: 'Anno', pt: 'Ano', ko: '연도', pl: 'Rok', az: 'İl'
            },
            'rating': {
                tr: 'Değerlendirme', en: 'Rating', de: 'Bewertung', fr: 'Évaluation', es: 'Valoración', ru: 'Оценка', zh: '评分', ja: '評価', it: 'Valutazione', pt: 'Avaliação', ko: '평가', pl: 'Ocena', az: 'Qiymətləndirmə'
            },
            'price': {
                tr: 'Fiyat', en: 'Price', de: 'Preis', fr: 'Prix', es: 'Precio', ru: 'Цена', zh: '价格', ja: '価格', it: 'Prezzo', pt: 'Preço', ko: '가격', pl: 'Cena', az: 'Qiymət'
            },
            'reviews': {
                tr: 'İncelemeler', en: 'Reviews', de: 'Rezensionen', fr: 'Avis', es: 'Reseñas', ru: 'Отзывы', zh: '评论', ja: 'レビュー', it: 'Recensioni', pt: 'Avaliações', ko: '리뷰', pl: 'Recenzje', az: 'Rəylər'
            },
            'about_game': {
                tr: 'Bu Oyun Hakkında', en: 'About This Game', de: 'Über dieses Spiel', fr: 'À propos de ce jeu', es: 'Acerca de este juego', ru: 'Об этой игре', zh: '关于本游戏', ja: 'このゲームについて', it: 'Informazioni su questo gioco', pt: 'Sobre este jogo', ko: '이 게임에 대하여', pl: 'O tej grze', az: 'Bu Oyun Haqqında'
            },
            'game_description': {
                tr: 'Oyun açıklaması burada yüklenecek...', en: 'Game description will be loaded here...', de: 'Spielbeschreibung wird hier geladen...', fr: 'La description du jeu sera chargée ici...', es: 'La descripción del juego se cargará aquí...', ru: 'Описание игры будет загружено здесь...', zh: '游戏描述将在此加载...', ja: 'ゲームの説明がここに表示されます...', it: 'La descrizione del gioco verrà caricata qui...', pt: 'A descrição do jogo será carregada aqui...', ko: '게임 설명이 여기에 표시됩니다...', pl: 'Opis gry zostanie tutaj załadowany...', az: 'Oyun təsviri burada yüklənəcək...'
            },
            'publisher': {
                tr: 'Yayıncı', en: 'Publisher', de: 'Herausgeber', fr: 'Éditeur', es: 'Editor', ru: 'Издатель', zh: '发行商', ja: 'パブリッシャー', it: 'Editore', pt: 'Editora', ko: '퍼블리셔', pl: 'Wydawca', az: 'Nəşriyyatçı'
            },
            'release_date': {
                tr: 'Çıkış Tarihi', en: 'Release Date', de: 'Erscheinungsdatum', fr: 'Date de sortie', es: 'Fecha de lanzamiento', ru: 'Дата выхода', zh: '发布日期', ja: '発売日', it: 'Data di rilascio', pt: 'Data de lançamento', ko: '출시일', pl: 'Data wydania', az: 'Buraxılış Tarixi'
            },
            'genres': {
                tr: 'Türler', en: 'Genres', de: 'Genres', fr: 'Genres', es: 'Géneros', ru: 'Жанры', zh: '类型', ja: 'ジャンル', it: 'Generi', pt: 'Gêneros', ko: '장르', pl: 'Gatunki', az: 'Janrlar'
            },
            'open_in_steam': {
                tr: "Steam'de Aç", en: 'Open in Steam', de: 'In Steam öffnen', fr: 'Ouvrir dans Steam', es: 'Abrir en Steam', ru: 'Открыть в Steam', zh: '在Steam中打开', ja: 'Steamで開く', it: 'Apri su Steam', pt: 'Abrir no Steam', ko: 'Steam에서 열기', pl: 'Otwórz w Steam', az: 'Steam-də Aç'
            },
            'loading_games': {
                tr: 'Yükleniyor...', en: 'Loading...', de: 'Lädt...', fr: 'Chargement...', es: 'Cargando...', ru: 'Загрузка...', zh: '加载中...', ja: '読み込み中...', it: 'Caricamento...', pt: 'Carregando...', ko: '로딩 중...', ar: 'جاري التحميل...', az: 'Yüklənir...'
            },
            'feature_coming_soon': {
                tr: 'Oyunu başlatma özelliği yakında eklenecek.', en: 'Game launch feature coming soon.', de: 'Spielstart-Funktion kommt bald.', fr: 'Fonction de lancement du jeu bientôt disponible.', es: 'La función de inicio de juego llegará pronto.', ru: 'Функция запуска игры скоро появится.', zh: '即将推出游戏启动功能。', ja: 'ゲーム起動機能は近日公開予定です。', it: 'La funzione di avvio del gioco arriverà presto.', pt: 'Recurso de iniciar jogo em breve.', ko: '게임 실행 기능 곧 제공 예정.', pl: 'Funkcja uruchamiania gry już wkrótce.', az: 'Oyun başlatma xüsusiyyəti tezliklə əlavə ediləcək.' },
            'error': { tr: 'Hata', en: 'Error', de: 'Fehler', fr: 'Erreur', es: 'Error', ru: 'Ошибка', zh: '错误', ja: 'エラー', it: 'Errore', pt: 'Erro', ko: '오류', pl: 'Błąd', az: 'Xəta' },
            'success': { tr: 'Başarılı', en: 'Success', de: 'Erfolg', fr: 'Succès', es: 'Éxito', ru: 'Успешно', zh: '成功', ja: '成功', it: 'Successo', pt: 'Sucesso', ko: '성공', pl: 'Sukces', az: 'Uğurlu' },
            'info': { tr: 'Bilgi', en: 'Info', de: 'Info', fr: 'Info', es: 'Información', ru: 'Инфо', zh: '信息', ja: '情報', it: 'Info', pt: 'Informação', ko: '정보', pl: 'Informacja', az: 'Məlumat' },
            'game_not_found': { tr: 'Oyun bulunamadı', en: 'Game not found', de: 'Spiel nicht gefunden', fr: 'Jeu introuvable', es: 'Juego no encontrado', ru: 'Игра не найдена', zh: '未找到游戏', ja: 'ゲームが見つかりません', it: 'Gioco non trovato', pt: 'Jogo não encontrado', ko: '게임을 찾을 수 없음', pl: 'Nie znaleziono gry', az: 'Oyun tapılmadı' },
            'game_deleted': { tr: 'Oyun kütüphaneden silindi.', en: 'Game deleted from library.', de: 'Spiel aus Bibliothek gelöscht.', fr: 'Jeu supprimé de la bibliothèque.', es: 'Juego eliminado de la biblioteca.', ru: 'Игра удалена из библиотеки.', zh: '游戏已从库中删除。', ja: 'ライブラリからゲームが削除されました。', it: 'Gioco eliminato dalla libreria.', pt: 'Jogo removido da biblioteca.', ko: '라이브러리에서 게임이 삭제되었습니다.', pl: 'Gra została usunięta z biblioteki.', az: 'Oyun kitabxanadan silindi.' },
            'game_delete_failed': { tr: 'Oyun silinemedi.', en: 'Game could not be deleted.', de: 'Spiel konnte nicht gelöscht werden.', fr: 'Impossible de supprimer le jeu.', es: 'No se pudo eliminar el juego.', ru: 'Не удалось удалить игру.', zh: '无法删除游戏。', ja: 'ゲームを削除できませんでした。', it: 'Impossibile eliminare il gioco.', pt: 'Não foi possível remover o jogo.', ko: '게임을 삭제할 수 없습니다.', pl: 'Nie można usunąć gry.', az: 'Oyun silinə bilmədi.' },
            'feature_coming_soon': { tr: 'Oyunu başlatma özelliği yakında eklenecek.', en: 'Game launch feature coming soon.', de: 'Spielstart-Funktion kommt bald.', fr: 'Fonction de lancement du jeu bientôt disponible.', es: 'La función de inicio de juego llegará pronto.', ru: 'Функция запуска игры скоро появится.', zh: '即将推出游戏启动功能。', ja: 'ゲーム起動機能は近日公開予定です。', it: 'La funzione di avvio del gioco arriverà presto.', pt: 'Recurso de iniciar jogo em breve.', ko: '게임 실행 기능 곧 제공 예정.', pl: 'Funkcja uruchamiania gry już wkrótce.', az: 'Oyun başlatma xüsusiyyəti tezliklə əlavə ediləcək.' },
            'settings_saved': { tr: 'Ayarlar kaydedildi', en: 'Settings saved', de: 'Einstellungen gespeichert', fr: 'Paramètres enregistrés', es: 'Configuración guardada', ru: 'Настройки сохранены', zh: '设置已保存', ja: '設定が保存されました', it: 'Impostazioni salvate', pt: 'Configurações salvas', ko: '설정이 저장되었습니다', pl: 'Ustawienia zapisane', az: 'Parametrlər saxlanıldı' },
            'settings_save_failed': { tr: 'Ayarlar kaydedilemedi', en: 'Settings could not be saved', de: 'Einstellungen konnten nicht gespeichert werden', fr: 'Impossible d\'enregistrer les paramètres', es: 'No se pudo guardar la configuración', ru: 'Не удалось сохранить настройки', zh: '无法保存设置', ja: '設定を保存できませんでした', it: 'Impossibile salvare le impostazioni', pt: 'Não foi possível salvar as configurações', ko: '설정을 저장할 수 없습니다', pl: 'Nie można zapisać ustawień', az: 'Parametrlər saxlanıla bilmədi' },
            'config_load_failed': { tr: 'Yapılandırma yüklenemedi', en: 'Configuration could not be loaded', de: 'Konfiguration konnte nicht geladen werden', fr: 'Impossible de charger la configuration', es: 'No se pudo cargar la configuración', ru: 'Не удалось загрузить конфигурацию', zh: '无法加载配置', ja: '構成を読み込めませんでした', it: 'Impossibile caricare la configurazione', pt: 'Não foi possível carregar a configuração', ko: '구성을 불러올 수 없습니다', pl: 'Nie można załadować konfiguracji', az: 'Konfiqurasiya yüklənə bilmədi' },
            'steam_path_set': { tr: 'Steam yolu başarıyla yapılandırıldı', en: 'Steam path set successfully', de: 'Steam-Pfad erfolgreich festgelegt', fr: 'Chemin Steam défini avec succès', es: 'Ruta de Steam configurada correctamente', ru: 'Путь к Steam успешно установлен', zh: 'Steam路径设置成功', ja: 'Steamパスが正常に設定されました', it: 'Percorso Steam impostato con successo', pt: 'Caminho do Steam definido com sucesso', ko: 'Steam 경로가 성공적으로 설정되었습니다', pl: 'Ścieżka Steam została pomyślnie ustawiona', az: 'Steam yolu uğurla konfiqurasiya edildi' },
            'steam_path_failed': { tr: 'Steam yolu seçilemedi', en: 'Failed to set Steam path', de: 'Steam-Pfad konnte nicht festgelegt werden', fr: 'Impossible de définir le chemin Steam', es: 'No se pudo establecer la ruta de Steam', ru: 'Не удалось установить путь к Steam', zh: '无法设置Steam路径', ja: 'Steamパスを設定できませんでした', it: 'Impossibile impostare il percorso Steam', pt: 'Não foi possível definir o caminho do Steam', ko: 'Steam 경로를 설정할 수 없습니다', pl: 'Nie można ustawić ścieżki Steam', az: 'Steam yolu seçilə bilmədi' },
            'restart_steam_title': { tr: "Steam'i Yeniden Başlat", en: 'Restart Steam', de: 'Steam neu starten', fr: 'Redémarrer Steam', es: 'Reiniciar Steam', ru: 'Перезапустить Steam', zh: '重新启动Steam', ja: 'Steamを再起動', it: 'Riavvia Steam', pt: 'Reiniciar Steam', ko: 'Steam 재시작', pl: 'Uruchom ponownie Steam', az: 'Steam-i Yenidən Başlat' },
            'restart_steam_info': { tr: "Oyun kütüphanenize eklendi! Değişiklikleri görmek için Steam'in yeniden başlatılması gerekiyor.", en: 'Game added to your library! To see the changes, Steam needs to be restarted.', de: 'Spiel zur Bibliothek hinzugefügt! Um die Änderungen zu sehen, muss Steam neu gestartet werden.', fr: 'Jeu ajouté à votre bibliothèque ! Pour voir les modifications, Steam doit être redémarré.', es: '¡Juego añadido a tu biblioteca! Para ver los cambios, es necesario reiniciar Steam.', ru: 'Игра добавлена в вашу библиотеку! Чтобы увидеть изменения, необходимо перезапустить Steam.', zh: '游戏已添加到您的库中！要查看更改，需要重新启动Steam。', ja: 'ゲームがライブラリに追加されました！変更を反映するにはSteamを再起動してください。', it: 'Gioco aggiunto alla tua libreria! Per vedere le modifiche, è necessario riavviare Steam.', pt: 'Jogo adicionado à sua biblioteca! Para ver as alterações, é necessário reiniciar o Steam.', ko: '게임이 라이브러리에 추가되었습니다! 변경 사항을 보려면 Steam을 재시작해야 합니다.', pl: 'Gra została dodana do twojej biblioteki! Aby zobaczyć zmiany, musisz ponownie uruchomić Steam.', az: 'Oyun kitabxananıza əlavə edildi! Dəyişiklikləri görmək üçün Steam-in yenidən başladılması lazımdır.' },
            'restart_steam_question': { tr: "Steam'i şimdi yeniden başlatmak istiyor musunuz?", en: 'Do you want to restart Steam now?', de: 'Möchten Sie Steam jetzt neu starten?', fr: 'Voulez-vous redémarrer Steam maintenant ?', es: '¿Quieres reiniciar Steam ahora?', ru: 'Вы хотите перезапустить Steam сейчас?', zh: '现在要重新启动Steam吗？', ja: '今すぐSteamを再起動しますか？', it: 'Vuoi riavviare Steam ora?', pt: 'Deseja reiniciar o Steam agora?', ko: '지금 Steam을 재시작하시겠습니까?', pl: 'Czy chcesz teraz ponownie uruchomić Steam?', az: 'Steam-i indi yenidən başlatmaq istəyirsiniz?' },
            'restart_steam_yes': { tr: 'Evet, Yeniden Başlat', en: 'Yes, Restart', de: 'Ja, neu starten', fr: 'Oui, redémarrer', es: 'Sí, reiniciar', ru: 'Да, перезапустить', zh: '是的，重新启动', ja: 'はい、再起動します', it: 'Sì, riavvia', pt: 'Sim, reiniciar', ko: '예, 재시작', pl: 'Tak, uruchom ponownie', az: 'Bəli, Yenidən Başlat' },
            'restart_steam_no': { tr: 'Hayır, Daha Sonra', en: 'No, Later', de: 'Nein, später', fr: 'Non, plus tard', es: 'No, más tarde', ru: 'Нет, позже', zh: '不，稍后', ja: 'いいえ、後で', it: 'No, più tardi', pt: 'Não, mais tarde', ko: '아니요, 나중에', pl: 'Nie, później', az: 'Xeyr, Sonra' },
            'select_dlcs': { tr: "DLC'leri Seç", en: 'Select DLCs', de: 'DLCs auswählen', fr: 'Sélectionner les DLC', es: 'Seleccionar DLCs', ru: 'Выбрать DLC', zh: '选择DLC', ja: 'DLCを選択', it: 'Seleziona DLC', pt: 'Selecionar DLCs', ko: 'DLC 선택', pl: 'Wybierz DLC', az: 'DLC-ləri Seç' },
            'add_selected': { tr: 'Seçilenleri Ekle', en: 'Add Selected', de: 'Ausgewählte hinzufügen', fr: 'Ajouter la sélection', es: 'Agregar seleccionados', ru: 'Добавить выбранные', zh: '添加所选', ja: '選択したものを追加', it: 'Aggiungi selezionati', pt: 'Adicionar selecionados', ko: '선택 항목 추가', pl: 'Dodaj wybrane', az: 'Seçilənləri Əlavə Et' },
            'cancel': { tr: 'İptal', en: 'Cancel', de: 'Abbrechen', fr: 'Annuler', es: 'Cancelar', ru: 'Отмена', zh: '取消', ja: 'キャンセル', it: 'Annulla', pt: 'Cancelar', ko: '취소', pl: 'Anuluj', az: 'Ləğv Et' },
            'select_all_dlcs': {
                tr: "Tüm DLC'leri Seç", en: 'Select All DLCs', de: 'Alle DLCs auswählen', fr: 'Tout sélectionner', es: 'Seleccionar todos los DLC', ru: 'Выбрать все DLC', zh: '全选DLC', ja: 'すべてのDLCを選択', it: 'Seleziona tutti i DLC', pt: 'Selecionar todos os DLCs', ko: '모든 DLC 선택', pl: 'Zaznacz wszystkie DLC', az: 'Bütün DLC-ləri Seç'
            },
            'dlc_free': {
                tr: 'Ücretsiz', en: 'Free', de: 'Kostenlos', fr: 'Gratuit', es: 'Gratis', ru: 'Бесплатно', zh: '免费', ja: '無料', it: 'Gratis', pt: 'Grátis', ko: '무료', pl: 'Darmowe', az: 'Pulsuz'
            },
            'dlc_price': {
                tr: 'Fiyat', en: 'Price', de: 'Preis', fr: 'Prix', es: 'Precio', ru: 'Цена', zh: '价格', ja: '価格', it: 'Prezzo', pt: 'Preço', ko: '가격', pl: 'Cena', az: 'Qiymət'
            },
            'dlc_release_date': {
                tr: 'Çıkış Tarihi', en: 'Release Date', de: 'Erscheinungsdatum', fr: 'Date de sortie', es: 'Fecha de lanzamiento', ru: 'Дата выхода', zh: '发布日期', ja: '発売日', it: 'Data di rilascio', pt: 'Data de lançamento', ko: '출시일', pl: 'Data wydania', az: 'Buraxılış Tarixi'
            },
            'game_added_with_dlcs': {
                tr: 'Oyun {dlcCount} DLC ile eklendi',
                en: 'Game added with {dlcCount} DLC(s)',
                de: 'Spiel mit {dlcCount} DLC(s) hinzugefügt',
                fr: 'Jeu ajouté avec {dlcCount} DLC',
                es: 'Juego añadido con {dlcCount} DLC(s)',
                ru: 'Игра добавлена с {dlcCount} DLC',
                zh: '已添加带有{dlcCount}个DLC的游戏',
                ja: '{dlcCount}個のDLC付きでゲームが追加されました',
                it: 'Gioco aggiunto con {dlcCount} DLC',
                pt: 'Jogo adicionado com {dlcCount} DLC(s)',
                ko: '{dlcCount}개의 DLC와 함께 게임이 추가되었습니다',
                pl: 'Gra dodana z {dlcCount} DLC',
                az: 'Oyun {dlcCount} DLC ilə əlavə edildi'
            },
            'game_add_with_dlcs_failed': {
                tr: 'Oyun DLC\'lerle eklenemedi',
                en: 'Failed to add game with DLCs',
                de: 'Spiel konnte mit DLCs nicht hinzugefügt werden',
                fr: 'Échec de l\'ajout du jeu avec les DLC',
                es: 'No se pudo añadir el juego con los DLC',
                ru: 'Не удалось добавить игру с DLC',
                zh: '无法添加带有DLC的游戏',
                ja: 'DLC付きのゲームを追加できませんでした',
                it: 'Impossibile aggiungere il gioco con i DLC',
                pt: 'Falha ao adicionar o jogo com DLCs',
                ko: 'DLC와 함께 게임을 추가하지 못했습니다',
                pl: 'Nie można dodać gry z DLC',
                az: 'Oyun DLC ilə əlavə edilə bilməz'
            },
            'mute_videos': {
                tr: 'Oyun detaylarındaki videoların sesi otomatik kapalı olsun',
                en: 'Mute videos in game details by default',
                de: 'Videos in Spieledetails standardmäßig stummschalten',
                fr: 'Couper le son des vidéos dans les détails du jeu par défaut',
                es: 'Silenciar videos en los detalles del juego por defecto',
                ru: 'Отключить звук видео в деталях игры по умолчанию',
                zh: '默认静音游戏详情中的视频',
                ja: 'ゲーム詳細の動画をデフォルトでミュート',
                it: 'Disattiva l\'audio dei video nei dettagli gioco',
                pt: 'Silenciar vídeos nos detalhes do jogo por padrão',
                ko: '게임 상세 정보의 비디오를 기본적으로 음소거',
                pl: 'Domyślnie wyciszaj filmy w szczegółach gry',
                az: 'Oyun təfərrüatlarında videoları avtomatik olaraq susdurun'
            },
            'refresh_library': {
                tr: 'Kütüphaneyi Yenile',
                en: 'Refresh Library',
                de: 'Bibliothek aktualisieren',
                fr: 'Actualiser la bibliothèque',
                es: 'Actualizar biblioteca',
                ru: 'Обновить библиотеку',
                zh: '刷新库',
                ja: 'ライブラリを更新',
                it: 'Aggiorna libreria',
                pt: 'Atualizar biblioteca',
                ko: '라이브러리 새로고침',
                pl: 'Odśwież bibliotekę',
                az: 'Kitabxananı yeniləyin'
            },
            'refreshing_library': {
                tr: 'Kütüphane yenileniyor...',
                en: 'Refreshing library...',
                de: 'Bibliothek wird aktualisiert...',
                fr: 'Actualisation de la bibliothèque...',
                es: 'Actualizando biblioteca...',
                ru: 'Обновление библиотеки...',
                zh: '正在刷新库...',
                ja: 'ライブラリを更新中...',
                it: 'Aggiornamento libreria...',
                pt: 'Atualizando biblioteca...',
                ko: '라이브러리 새로고침 중...',
                pl: 'Odświeżanie biblioteki...',
                az: 'Kitabxana yenilənir...'
            },
            'download': {
                tr: 'İndir',
                en: 'Download',
                de: 'Herunterladen',
                fr: 'Télécharger',
                es: 'Descargar',
                ru: 'Скачать',
                zh: '下载',
                ja: 'ダウンロード',
                it: 'Scarica',
                pt: 'Baixar',
                ko: '다운로드',
                pl: 'Pobierz',
                az: 'Yüklə'
            },
            'download_success': {
                tr: 'Oyun başarıyla indirildi',
                en: 'Game downloaded successfully',
                de: 'Spiel erfolgreich heruntergeladen',
                fr: 'Jeu téléchargé avec succès',
                es: 'Juego descargado exitosamente',
                ru: 'Игра успешно скачана',
                zh: '游戏下载成功',
                ja: 'ゲームが正常にダウンロードされました',
                it: 'Gioco scaricato con successo',
                pt: 'Jogo baixado com sucesso',
                ko: '게임이 성공적으로 다운로드되었습니다',
                pl: 'Gra została pomyślnie pobrana',
                az: 'Oyun uğurla yükləndi'
            },
            'download_failed': {
                tr: 'İndirme başarısız',
                en: 'Download failed',
                de: 'Download fehlgeschlagen',
                fr: 'Échec du téléchargement',
                es: 'Error al descargar',
                ru: 'Ошибка загрузки',
                zh: '下载失败',
                ja: 'ダウンロードに失敗しました',
                it: 'Download fallito',
                pt: 'Falha no download',
                ko: '다운로드 실패',
                pl: 'Pobieranie nie powiodło się',
                az: 'Yükləmə uğursuz oldu'
        
     
            },
            'library_refreshed': {
                tr: 'Kütüphane başarıyla yenilendi',
                en: 'Library refreshed successfully',
                de: 'Bibliothek erfolgreich aktualisiert',
                fr: 'Bibliothèque actualisée avec succès',
                es: 'Biblioteca actualizada correctamente',
                ru: 'Библиотека успешно обновлена',
                zh: '库刷新成功',
                ja: 'ライブラリが正常に更新されました',
                it: 'Libreria aggiornata con successo',
                pt: 'Biblioteca atualizada com sucesso',
                ko: '라이브러리가 성공적으로 새로고침되었습니다',
                pl: 'Biblioteka została pomyślnie odświeżona',
                az: 'Kitabxana uğurla yeniləndi'
            },
            'library_refresh_failed': {
                tr: 'Kütüphane yenilenemedi',
                en: 'Failed to refresh library',
                de: 'Bibliothek konnte nicht aktualisiert werden',
                fr: 'Échec de l\'actualisation de la bibliothèque',
                es: 'Error al actualizar biblioteca',
                ru: 'Не удалось обновить библиотеку',
                zh: '刷新库失败',
                ja: 'ライブラリの更新に失敗しました',
                it: 'Impossibile aggiornare la libreria',
                pt: 'Falha ao atualizar biblioteca',
                ko: '라이브러리 새로고침 실패',
                pl: 'Nie udało się odświeżyć biblioteki',
                az: 'Kitabxana yenilənə bilməz'
            },
            'manual_install': {
                tr: 'Manuel Kurulum',
                en: 'Manual Install',
                de: 'Manuelle Installation',
                fr: 'Installation manuelle',
                es: 'Instalación manual',
                ru: 'Ручная установка',
                zh: '手动安装',
                ja: '手動インストール',
                it: 'Installazione manuale',
                pt: 'Instalação manual',
                ko: '수동 설치',
                pl: 'Instalacja ręczna',
                az: 'Əlavə Quraşdırma'
            },
            'upload_game_file': {
                tr: 'Oyun Dosyasını Yükle',
                en: 'Upload Game File',
                de: 'Spieldatei hochladen',
                fr: 'Télécharger le fichier de jeu',
                es: 'Subir archivo de juego',
                ru: 'Загрузить файл игры',
                zh: '上传游戏文件',
                ja: 'ゲームファイルをアップロード',
                it: 'Carica file di gioco',
                pt: 'Enviar arquivo do jogo',
                ko: '게임 파일 업로드',
                pl: 'Prześlij plik gry',
                az: 'Oyun Faylını Yüklə'
            },
            'drag_drop_zip': {
                tr: 'ZIP dosyasını buraya sürükleyip bırakın veya tıklayarak seçin',
                en: 'Drag and drop ZIP file here or click to select',
                de: 'ZIP-Datei hierher ziehen oder klicken zum Auswählen',
                fr: 'Glissez-déposez le fichier ZIP ici ou cliquez pour sélectionner',
                es: 'Arrastra y suelta el archivo ZIP aquí o haz clic para seleccionar',
                ru: 'Перетащите ZIP файл сюда или нажмите для выбора',
                zh: '拖放ZIP文件到此处或点击选择',
                ja: 'ZIPファイルをここにドラッグ＆ドロップするか、クリックして選択',
                it: 'Trascina e rilascia il file ZIP qui o clicca per selezionare',
                pt: 'Arraste e solte o arquivo ZIP aqui ou clique para selecionar',
                ko: 'ZIP 파일을 여기에 끌어다 놓거나 클릭하여 선택',
                pl: 'Przeciągnij i upuść plik ZIP tutaj lub kliknij, aby wybrać',
                az: 'ZIP faylını buraya sürükləyin və ya seçin'
            },
            'select_file': {
                tr: 'Dosya Seç',
                en: 'Select File',
                de: 'Datei auswählen',
                fr: 'Sélectionner le fichier',
                es: 'Seleccionar archivo',
                ru: 'Выбрать файл',
                zh: '选择文件',
                ja: 'ファイルを選択',
                it: 'Seleziona file',
                pt: 'Selecionar arquivo',
                ko: '파일 선택',
                pl: 'Wybierz plik',
                az: 'Fayl Seç'
            },
            'game_info': {
                tr: 'Oyun Bilgileri',
                en: 'Game Information',
                de: 'Spielinformationen',
                fr: 'Informations sur le jeu',
                es: 'Información del juego',
                ru: 'Информация об игре',
                zh: '游戏信息',
                ja: 'ゲーム情報',
                it: 'Informazioni sul gioco',
                pt: 'Informações do jogo',
                ko: '게임 정보',
                pl: 'Informacje o grze',
                az: 'Oyun Məlumatları'
            },
            'game_name': {
                tr: 'Oyun Adı',
                en: 'Game Name',
                de: 'Spielname',
                fr: 'Nom du jeu',
                es: 'Nombre del juego',
                ru: 'Название игры',
                zh: '游戏名称',
                ja: 'ゲーム名',
                it: 'Nome del gioco',
                pt: 'Nome do jogo',
                ko: '게임 이름',
                pl: 'Nazwa gry',
                az: 'Oyun Adı'
            },
            'steam_app_id': {
                tr: 'Steam App ID ',
                en: 'Steam App ID ',
                de: 'Steam App ID ',
                fr: 'ID de l\'application Steam ',
                es: 'ID de la aplicación Steam ',
                ru: 'ID приложения Steam ',
                zh: 'Steam应用ID',
                ja: 'SteamアプリID',
                it: 'ID app Steam ',
                pt: 'ID do aplicativo Steam',
                ko: 'Steam 앱 ID ',
                pl: 'ID aplikacji Steam ',
                az: 'Steam App ID '
            },
            'game_folder': {
                tr: 'Oyun Klasörü',
                en: 'Game Folder',
                de: 'Spielordner',
                fr: 'Dossier du jeu',
                es: 'Carpeta del juego',
                ru: 'Папка игры',
                zh: '游戏文件夹',
                ja: 'ゲームフォルダ',
                it: 'Cartella del gioco',
                pt: 'Pasta do jogo',
                ko: '게임 폴더',
                pl: 'Folder gry',
                az: 'Oyun Qovlu'
            },
            'install_game': {
                tr: 'Oyunu Kur',
                en: 'Install Game',
                de: 'Spiel installieren',
                fr: 'Installer le jeu',
                es: 'Instalar juego',
                ru: 'Установить игру',
                zh: '安装游戏',
                ja: 'ゲームをインストール',
                it: 'Installa gioco',
                pt: 'Instalar jogo',
                ko: '게임 설치',
                pl: 'Zainstaluj grę',
                az: 'Oyunu quraşdır'
            },
            'only_zip_supported': {
                tr: 'Sadece ZIP dosyaları desteklenir',
                en: 'Only ZIP files are supported',
                de: 'Nur ZIP-Dateien werden unterstützt',
                fr: 'Seuls les fichiers ZIP sont pris en charge',
                es: 'Solo se admiten archivos ZIP',
                ru: 'Поддерживаются только ZIP файлы',
                zh: '仅支持ZIP文件',
                ja: 'ZIPファイルのみサポートされています',
                it: 'Sono supportati solo file ZIP',
                pt: 'Apenas arquivos ZIP são suportados',
                ko: 'ZIP 파일만 지원됩니다',
                pl: 'Obsługiwane są tylko pliki ZIP',
                az: 'Yalnız ZIP faylları qoşulur'
            },
            'file_not_found': {
                tr: 'Seçilen dosya bulunamadı',
                en: 'Selected file not found',
                de: 'Ausgewählte Datei nicht gefunden',
                fr: 'Fichier sélectionné introuvable',
                es: 'Archivo seleccionado no encontrado',
                ru: 'Выбранный файл не найден',
                zh: '未找到所选文件',
                ja: '選択されたファイルが見つかりません',
                it: 'File selezionato non trovato',
                pt: 'Arquivo selecionado não encontrado',
                ko: '선택한 파일을 찾을 수 없습니다',
                pl: 'Nie znaleziono wybranego pliku',
                az: 'Seçilmiş fayl tapılmadı'
            },
            'invalid_zip': {
                tr: 'Geçersiz ZIP dosyası',
                en: 'Invalid ZIP file',
                de: 'Ungültige ZIP-Datei',
                fr: 'Fichier ZIP invalide',
                es: 'Archivo ZIP inválido',
                ru: 'Неверный ZIP файл',
                zh: '无效的ZIP文件',
                ja: '無効なZIPファイル',
                it: 'File ZIP non valido',
                pt: 'Arquivo ZIP inválido',
                ko: '잘못된 ZIP 파일',
                pl: 'Nieprawidłowy plik ZIP',
                az: 'Yanlış ZIP faylı'
            },
            'game_installed_successfully': {
                tr: 'Oyun başarıyla kuruldu',
                en: 'Game installed successfully',
                de: 'Spiel erfolgreich installiert',
                fr: 'Jeu installé avec succès',
                es: 'Juego instalado correctamente',
                ru: 'Игра успешно установлена',
                zh: '游戏安装成功',
                ja: 'ゲームが正常にインストールされました',
                it: 'Gioco installato con successo',
                pt: 'Jogo instalado com sucesso',
                ko: '게임이 성공적으로 설치되었습니다',
                pl: 'Gra została pomyślnie zainstalowana',
                az: 'Oyun uğurla quraşdırıldı'
            },
            'installation_failed': {
                tr: 'Kurulum başarısız',
                en: 'Installation failed',
                de: 'Installation fehlgeschlagen',
                fr: 'Échec de l\'installation',
                es: 'Error en la instalación',
                ru: 'Ошибка установки',
                zh: '安装失败',
                ja: 'インストールに失敗しました',
                it: 'Installazione fallita',
                pt: 'Falha na instalação',
                ko: '설치 실패',
                pl: 'Instalacja nie powiodła się',
                az: 'Quraşdırma uğursuz oldu'
            },
            'please_select_file': {
                tr: 'Lütfen önce bir dosya seçin',
                en: 'Please select a file first',
                de: 'Bitte wählen Sie zuerst eine Datei aus',
                fr: 'Veuillez d\'abord sélectionner un fichier',
                es: 'Por favor, selecciona un archivo primero',
                ru: 'Пожалуйста, сначала выберите файл',
                zh: '请先选择文件',
                ja: '最初にファイルを選択してください',
                it: 'Seleziona prima un file',
                pt: 'Por favor, selecione um arquivo primeiro',
                ko: '먼저 파일을 선택하세요',
                pl: 'Najpierw wybierz plik',
                az: 'Əvvəlcə fayl seçin'
            },

            'installation_error': {
                tr: 'Kurulum sırasında hata oluştu',
                en: 'Error occurred during installation',
                de: 'Fehler bei der Installation aufgetreten',
                fr: 'Erreur survenue lors de l\'installation',
                es: 'Error durante la instalación',
                ru: 'Произошла ошибка во время установки',
                zh: '安装过程中发生错误',
                ja: 'インストール中にエラーが発生しました',
                it: 'Errore durante l\'installazione',
                pt: 'Erro durante a instalação',
                ko: '설치 중 오류가 발생했습니다',
                pl: 'Wystąpił błąd podczas instalacji',
                az: 'Quraşdırma zamanında xəta baş verdi'
            },
            'selected_file': {
                tr: 'Seçilen Dosya',
                en: 'Selected File',
                de: 'Ausgewählte Datei',
                fr: 'Fichier sélectionné',
                es: 'Archivo seleccionado',
                ru: 'Выбранный файл',
                zh: '已选择的文件',
                ja: '選択されたファイル',
                it: 'File selezionato',
                pt: 'Arquivo selecionado',
                ko: '선택된 파일',
                pl: 'Wybrany plik',
                az: 'Seçilmiş Fayl'
            },
            'file_name': {
                tr: 'Dosya Adı',
                en: 'File Name',
                de: 'Dateiname',
                fr: 'Nom du fichier',
                es: 'Nombre del archivo',
                ru: 'Имя файла',
                zh: '文件名',
                ja: 'ファイル名',
                it: 'Nome file',
                pt: 'Nome do arquivo',
                ko: '파일 이름',
                pl: 'Nazwa pliku',
                az: 'Fayl adı'
            },
            'size': {
                tr: 'Boyut',
                en: 'Size',
                de: 'Größe',
                fr: 'Taille',
                es: 'Tamaño',
                ru: 'Размер',
                zh: '大小',
                ja: 'サイズ',
                it: 'Dimensione',
                pt: 'Tamanho',
                ko: '크기',
                pl: 'Rozmiar',
                az: 'Ölçü'
            },
            'select_another_file': {
                tr: 'Başka Dosya Seç',
                en: 'Select Another File',
                de: 'Andere Datei auswählen',
                fr: 'Sélectionner un autre fichier',
                es: 'Seleccionar otro archivo',
                ru: 'Выбрать другой файл',
                zh: '选择其他文件',
                ja: '別のファイルを選択',
                it: 'Seleziona altro file',
                pt: 'Selecionar outro arquivo',
                ko: '다른 파일 선택',
                pl: 'Wybierz inny plik',
                az: 'Başqa Fayl Seç'
            },
            'language': {
                tr: 'Dil',
                en: 'Language',
                de: 'Sprache',
                fr: 'Langue',
                es: 'Idioma',
                ru: 'Язык',
                zh: '语言',
                ja: '言語',
                it: 'Lingua',
                pt: 'Idioma',
                ko: '언어',
                pl: 'Język',
                ar: 'اللغة',
                az: 'Dil'
            },
            'lang_tr': {
                tr: 'Türkçe',
                en: 'Turkish',
                de: 'Türkisch',
                fr: 'Turc',
                es: 'Turco',
                ru: 'Турецкий',
                zh: '土耳其语',
                ja: 'トルコ語',
                it: 'Turco',
                pt: 'Turco',
                ko: '터키어',
                pl: 'Turecki',
                ar: 'التركية',
                az: 'Türk dili'
            },
            'lang_en': {
                tr: 'İngilizce',
                en: 'English',
                de: 'Englisch',
                fr: 'Anglais',
                es: 'Inglés',
                ru: 'Английский',
                zh: '英语',
                ja: '英語',
                it: 'Inglese',
                pt: 'Inglês',
                ko: '영어',
                pl: 'Angielski',
                ar: 'الإنجليزية',
                az: 'İngilis dili'
            },
            'lang_de': {
                tr: 'Almanca',
                en: 'German',
                de: 'Deutsch',
                fr: 'Allemand',
                es: 'Alemán',
                ru: 'Немецкий',
                zh: '德语',
                ja: 'ドイツ語',
                it: 'Tedesco',
                pt: 'Alemão',
                ko: '독일어',
                pl: 'Niemiecki',
                ar: 'الألمانية',
                az: 'Alman dili'
            },
            'lang_fr': {
                tr: 'Fransızca',
                en: 'French',
                de: 'Französisch',
                fr: 'Français',
                es: 'Francés',
                ru: 'Французский',
                zh: '法语',
                ja: 'フランス語',
                it: 'Francese',
                pt: 'Francês',
                ko: '프랑스어',
                pl: 'Francuski',
                ar: 'الفرنسية',
                az: 'Fransız dili'
            },
            'lang_es': {
                tr: 'İspanyolca',
                en: 'Spanish',
                de: 'Spanisch',
                fr: 'Espagnol',
                es: 'Español',
                ru: 'Испанский',
                zh: '西班牙语',
                ja: 'スペイン語',
                it: 'Spagnolo',
                pt: 'Espanhol',
                ko: '스페인어',
                pl: 'Hiszpański',
                ar: 'الإسبانية',
                az: 'İspan dili'
            },
            'lang_ru': {
                tr: 'Rusça',
                en: 'Russian',
                de: 'Russisch',
                fr: 'Russe',
                es: 'Ruso',
                ru: 'Русский',
                zh: '俄语',
                ja: 'ロシア語',
                it: 'Russo',
                pt: 'Russo',
                ko: '러시아어',
                pl: 'Rosyjski',
                ar: 'الروسية',
                az: 'Rus dili'
            },
            'lang_zh': {
                tr: 'Çince',
                en: 'Chinese',
                de: 'Chinesisch',
                fr: 'Chinois',
                es: 'Chino',
                ru: 'Китайский',
                zh: '中文',
                ja: '中国語',
                it: 'Cinese',
                pt: 'Chinês',
                ko: '중국어',
                pl: 'Chiński',
                ar: 'الصينية',
                az: 'Çin dili'
            },
            'lang_ja': {
                tr: 'Japonca',
                en: 'Japanese',
                de: 'Japanisch',
                fr: 'Japonais',
                es: 'Japonés',
                ru: 'Японский',
                zh: '日语',
                ja: '日本語',
                it: 'Giapponese',
                pt: 'Japonês',
                ko: '일본어',
                pl: 'Japoński',
                ar: 'اليابانية',
                az: 'Yapon dili'
            },
            'lang_it': {
                tr: 'İtalyanca',
                en: 'Italian',
                de: 'Italienisch',
                fr: 'Italien',
                es: 'Italiano',
                ru: 'Итальянский',
                zh: '意大利语',
                ja: 'イタリア語',
                it: 'Italiano',
                pt: 'Italiano',
                ko: '이탈리아어',
                pl: 'Włoski',
                ar: 'الإيطالية',
                az: 'İtalyan dili'
            },
            'lang_pt': {
                tr: 'Portekizce',
                en: 'Portuguese',
                de: 'Portugiesisch',
                fr: 'Portugais',
                es: 'Portugués',
                ru: 'Португальский',
                zh: '葡萄牙语',
                ja: 'ポルトガル語',
                it: 'Portoghese',
                pt: 'Português',
                ko: '포르투갈어',
                pl: 'Portugalski',
                ar: 'البرتغالية',
                az: 'Portuqal dili'
            },
            'lang_ko': {
                tr: 'Korece',
                en: 'Korean',
                de: 'Koreanisch',
                fr: 'Coréen',
                es: 'Coreano',
                ru: 'Корейский',
                zh: '韩语',
                ja: '韓国語',
                it: 'Coreano',
                pt: 'Coreano',
                ko: '한국어',
                pl: 'Koreański',
                ar: 'الكورية',
                az: 'Koreya dili'
            },
            'lang_pl': {
                tr: 'Lehçe',
                en: 'Polish',
                de: 'Polnisch',
                fr: 'Polonais',
                es: 'Polaco',
                ru: 'Польский',
                zh: '波兰语',
                ja: 'ポーランド語',
                it: 'Polacco',
                pt: 'Polonês',
                ko: '폴란드어',
                pl: 'Polski',
                ar: 'البولندية',
                az: 'Polyak dili'
            },
            'lang_ar': {
                tr: 'Arapça',
                en: 'Arabic',
                de: 'Arabisch',
                fr: 'Arabe',
                es: 'Árabe',
                ru: 'Арабский',
                zh: '阿拉伯语',
                ja: 'アラビア語',
                it: 'Arabo',
                pt: 'Árabe',
                ko: '아랍어',
                pl: 'Arabski',
                ar: 'العربية',
                az: 'Ərəb dili'
            },
            'lang_az': {
                tr: 'Azerbaycan dili',
                en: 'Azerbaijani',
                de: 'Aserbaidschanisch',
                fr: 'Azéri',
                es: 'Azerbaiyano',
                ru: 'Азербайджанский',
                zh: '阿塞拜疆语',
                ja: 'アゼルバイジャン語',
                it: 'Azero',
                pt: 'Azerbaijano',
                ko: '아제르바이잔어',
                pl: 'Azerbejdżański',
                ar: 'الأذرية',
                az: 'Azərbaycan dili'
            },
            'online_pass': {
                tr: 'Online Pass',
                en: 'Online Pass',
                de: 'Online Pass',
                fr: 'Pass en ligne',
                es: 'Pase en línea',
                ru: 'Онлайн пасс',
                zh: '在线通行证',
                ja: 'オンラインパス',
                it: 'Pass online',
                pt: 'Passe online',
                ko: '온라인 패스',
                pl: 'Pasz online',
                ar: 'جواز المرور عبر الإنترنت',
                az: 'Online Pass'
            },
            'online_add': {
                tr: 'Online Ekle',
                en: 'Add Online',
                de: 'Online hinzufügen',
                fr: 'Ajouter en ligne',
                es: 'Agregar en línea',
                ru: 'Добавить онлайн',
                zh: '在线添加',
                ja: 'オンライン追加',
                it: 'Aggiungi online',
                pt: 'Adicionar online',
                ko: '온라인 추가',
                pl: 'Dodaj online',
                ar: 'إضافة عبر الإنترنت',
                az: 'Online Əlavə Et'
            },
            'online_games_loading': {
                tr: 'Online oyunlar yükleniyor...',
                en: 'Loading online games...',
                de: 'Online-Spiele werden geladen...',
                fr: 'Chargement des jeux en ligne...',
                es: 'Cargando juegos en línea...',
                ru: 'Загрузка онлайн игр...',
                zh: '正在加载在线游戏...',
                ja: 'オンラインゲームを読み込み中...',
                it: 'Caricamento giochi online...',
                pt: 'Carregando jogos online...',
                ko: '온라인 게임 로딩 중...',
                pl: 'Ładowanie gier online...',
                ar: 'جاري تحميل الألعاب عبر الإنترنت...',
                az: 'Online oyunlar yüklənir...'
            },
            'online_games_load_failed': {
                tr: 'Online oyunlar yüklenemedi',
                en: 'Failed to load online games',
                de: 'Online-Spiele konnten nicht geladen werden',
                fr: 'Échec du chargement des jeux en ligne',
                es: 'Error al cargar juegos en línea',
                ru: 'Не удалось загрузить онлайн игры',
                zh: '无法加载在线游戏',
                ja: 'オンラインゲームの読み込みに失敗しました',
                it: 'Impossibile caricare i giochi online',
                pt: 'Falha ao carregar jogos online',
                ko: '온라인 게임 로드 실패',
                pl: 'Nie udało się załadować gier online',
                ar: 'فشل في تحميل الألعاب عبر الإنترنت',
                az: 'Online oyunlar yüklənə bilmədi'
            },
            'no_online_games': {
                tr: 'Hiç online oyun bulunamadı',
                en: 'No online games found',
                de: 'Keine Online-Spiele gefunden',
                fr: 'Aucun jeu en ligne trouvé',
                es: 'No se encontraron juegos en línea',
                ru: 'Онлайн игры не найдены',
                zh: '未找到在线游戏',
                ja: 'オンラインゲームが見つかりません',
                it: 'Nessun gioco online trovato',
                pt: 'Nenhum jogo online encontrado',
                ko: '온라인 게임을 찾을 수 없음',
                pl: 'Nie znaleziono gier online',
                ar: 'لم يتم العثور على ألعاب عبر الإنترنت',
                az: 'Heç bir online oyun tapılmadı'
            },
            'previous_page': {
                tr: '← Önceki',
                en: '← Previous',
                de: '← Zurück',
                fr: '← Précédent',
                es: '← Anterior',
                ru: '← Предыдущая',
                zh: '← 上一页',
                ja: '← 前へ',
                it: '← Precedente',
                pt: '← Anterior',
                ko: '← 이전',
                pl: '← Poprzednia',
                ar: '← السابق',
                az: '← Əvvəlki'
            },
            'next_page': {
                tr: 'Sonraki →',
                en: 'Next →',
                de: 'Weiter →',
                fr: 'Suivant →',
                es: 'Siguiente →',
                ru: 'Следующая →',
                zh: '下一页 →',
                ja: '次へ →',
                it: 'Successivo →',
                pt: 'Próximo →',
                ko: '다음 →',
                pl: 'Następna →',
                ar: 'التالي →',
                az: 'Sonrakı →'
            },
            'page_info': {
                tr: 'Sayfa {current} / {total} ({count} oyun)',
                en: 'Page {current} / {total} ({count} games)',
                de: 'Seite {current} / {total} ({count} Spiele)',
                fr: 'Page {current} / {total} ({count} jeux)',
                es: 'Página {current} / {total} ({count} juegos)',
                ru: 'Страница {current} / {total} ({count} игр)',
                zh: '第 {current} / {total} 页 ({count} 个游戏)',
                ja: 'ページ {current} / {total} ({count} ゲーム)',
                it: 'Pagina {current} / {total} ({count} giochi)',
                pt: 'Página {current} / {total} ({count} jogos)',
                ko: '페이지 {current} / {total} ({count} 게임)',
                pl: 'Strona {current} / {total} ({count} gier)',
                ar: 'الصفحة {current} / {total} ({count} لعبة)',
                az: 'Səhifə {current} / {total} ({count} oyun)'
            },
            'download_failed': {
                tr: 'İndirme başarısız',
                en: 'Download failed',
                de: 'Download fehlgeschlagen',
                fr: 'Échec du téléchargement',
                es: 'Error en la descarga',
                ru: 'Ошибка загрузки',
                zh: '下载失败',
                ja: 'ダウンロードに失敗しました',
                it: 'Download fallito',
                pt: 'Falha no download',
                ko: '다운로드 실패',
                pl: 'Pobieranie nie powiodło się',
                ar: 'فشل التحميل',
                az: 'Yükləmə uğursuz oldu'
            },
            'steam_page': {
                tr: 'Steam Sayfası',
                en: 'Steam Page',
                de: 'Steam-Seite',
                fr: 'Page Steam',
                es: 'Página de Steam',
                ru: 'Страница Steam',
                zh: 'Steam页面',
                ja: 'Steamページ',
                it: 'Pagina Steam',
                pt: 'Página Steam',
                ko: 'Steam 페이지',
                pl: 'Strona Steam',
                ar: 'صفحة Steam',
                az: 'Steam Səhifəsi'
            },
            'game_id': {
                tr: 'Oyun ID',
                en: 'Game ID',
                de: 'Spiel-ID',
                fr: 'ID du jeu',
                es: 'ID del juego',
                ru: 'ID игры',
                zh: '游戏ID',
                ja: 'ゲームID',
                it: 'ID gioco',
                pt: 'ID do jogo',
                ko: '게임 ID',
                pl: 'ID gry',
                ar: 'معرف اللعبة',
                az: 'Oyun ID'
            },
            'manual_install_required': {
                tr: 'Manuel Kurulum Gerekli',
                en: 'Manual Installation Required',
                de: 'Manuelle Installation erforderlich',
                fr: 'Installation manuelle requise',
                es: 'Instalación manual requerida',
                ru: 'Требуется ручная установка',
                zh: '需要手动安装',
                ja: '手動インストールが必要',
                it: 'Installazione manuale richiesta',
                pt: 'Instalação manual necessária',
                ko: '수동 설치 필요',
                pl: 'Wymagana instalacja ręczna',
                ar: 'التثبيت اليدوي مطلوب',
                az: 'Manual Quraşdırma Tələb Olunur'
            },
            'game_downloaded_successfully': {
                tr: 'Oyun Başarıyla İndirildi!',
                en: 'Game Downloaded Successfully!',
                de: 'Spiel erfolgreich heruntergeladen!',
                fr: 'Jeu téléchargé avec succès !',
                es: '¡Juego descargado exitosamente!',
                ru: 'Игра успешно загружена!',
                zh: '游戏下载成功！',
                ja: 'ゲームが正常にダウンロードされました！',
                it: 'Gioco scaricato con successo!',
                pt: 'Jogo baixado com sucesso!',
                ko: '게임이 성공적으로 다운로드되었습니다!',
                pl: 'Gra została pomyślnie pobrana!',
                ar: 'تم تحميل اللعبة بنجاح!',
                az: 'Oyun Uğurla Endirildi!'
            },
            'manual_install_steps': {
                tr: 'Manuel Kurulum Adımları:',
                en: 'Manual Installation Steps:',
                de: 'Schritte zur manuellen Installation:',
                fr: 'Étapes d\'installation manuelle :',
                es: 'Pasos de instalación manual:',
                ru: 'Шаги ручной установки:',
                zh: '手动安装步骤：',
                ja: '手動インストールの手順：',
                it: 'Passi per l\'installazione manuale:',
                pt: 'Passos da instalação manual:',
                ko: '수동 설치 단계:',
                pl: 'Kroki instalacji ręcznej:',
                ar: 'خطوات التثبيت اليدوي:',
                az: 'Manual Quraşdırma Addımları:'
            },
            'find_downloaded_zip': {
                tr: 'İndirilen ZIP dosyasını bulun',
                en: 'Find the downloaded ZIP file',
                de: 'Finden Sie die heruntergeladene ZIP-Datei',
                fr: 'Trouvez le fichier ZIP téléchargé',
                es: 'Encuentra el archivo ZIP descargado',
                ru: 'Найдите загруженный ZIP файл',
                zh: '找到下载的ZIP文件',
                ja: 'ダウンロードしたZIPファイルを見つける',
                it: 'Trova il file ZIP scaricato',
                pt: 'Encontre o arquivo ZIP baixado',
                ko: '다운로드된 ZIP 파일을 찾으세요',
                pl: 'Znajdź pobrany plik ZIP',
                ar: 'ابحث عن ملف ZIP المحمل',
                az: 'Endirilən ZIP faylını tapın'
            },
            'right_click_extract': {
                tr: 'ZIP dosyasını sağ tıklayın ve "Ayıkla" seçin',
                en: 'Right-click the ZIP file and select "Extract"',
                de: 'Klicken Sie mit der rechten Maustaste auf die ZIP-Datei und wählen Sie "Extrahieren"',
                fr: 'Clic droit sur le fichier ZIP et sélectionnez "Extraire"',
                es: 'Haz clic derecho en el archivo ZIP y selecciona "Extraer"',
                ru: 'Щелкните правой кнопкой мыши по ZIP файлу и выберите "Извлечь"',
                zh: '右键单击ZIP文件并选择"解压"',
                ja: 'ZIPファイルを右クリックして「展開」を選択',
                it: 'Fai clic destro sul file ZIP e seleziona "Estrai"',
                pt: 'Clique com o botão direito no arquivo ZIP e selecione "Extrair"',
                ko: 'ZIP 파일을 우클릭하고 "압축 해제"를 선택하세요',
                pl: 'Kliknij prawym przyciskiem myszy na plik ZIP i wybierz "Wyodrębnij"',
                ar: 'انقر بزر الماوس الأيمن على ملف ZIP واختر "استخراج"',
                az: 'ZIP faylına sağ klikləyin və "Çıxar" seçin'
            },
            'zip_password': {
                tr: 'ZIP şifresi:',
                en: 'ZIP password:',
                de: 'ZIP-Passwort:',
                fr: 'Mot de passe ZIP :',
                es: 'Contraseña ZIP:',
                ru: 'Пароль ZIP:',
                zh: 'ZIP密码：',
                ja: 'ZIPパスワード：',
                it: 'Password ZIP:',
                pt: 'Senha ZIP:',
                ko: 'ZIP 비밀번호:',
                pl: 'Hasło ZIP:',
                ar: 'كلمة مرور ZIP:',
                az: 'ZIP şifrəsi:'
            },
            'open_extracted_folder': {
                tr: 'Ayıklanan klasörü açın',
                en: 'Open the extracted folder',
                de: 'Öffnen Sie den extrahierten Ordner',
                fr: 'Ouvrez le dossier extrait',
                es: 'Abre la carpeta extraída',
                ru: 'Откройте извлеченную папку',
                zh: '打开解压后的文件夹',
                ja: '展開されたフォルダを開く',
                it: 'Apri la cartella estratta',
                pt: 'Abra a pasta extraída',
                ko: '압축 해제된 폴더를 여세요',
                pl: 'Otwórz wyodrębniony folder',
                ar: 'افتح المجلد المستخرج',
                az: 'Çıxarılan qovluğu açın'
            },
            'copy_game_files': {
                tr: 'Oyun dosyalarını istediğiniz konuma kopyalayın',
                en: 'Copy game files to your desired location',
                de: 'Kopieren Sie die Spieldateien an Ihren gewünschten Ort',
                fr: 'Copiez les fichiers du jeu à l\'emplacement souhaité',
                es: 'Copia los archivos del juego a tu ubicación deseada',
                ru: 'Скопируйте файлы игры в нужное место',
                zh: '将游戏文件复制到您想要的位置',
                ja: 'ゲームファイルを希望の場所にコピー',
                it: 'Copia i file del gioco nella posizione desiderata',
                pt: 'Copie os arquivos do jogo para o local desejado',
                ko: '게임 파일을 원하는 위치에 복사하세요',
                pl: 'Skopiuj pliki gry do żądanej lokalizacji',
                ar: 'انسخ ملفات اللعبة إلى الموقع المطلوب',
                az: 'Oyun fayllarını istədiyiniz yerə kopyalayın'
            },
            'run_exe_file': {
                tr: 'Oyunu başlatmak için .exe dosyasını çalıştırın',
                en: 'Run the .exe file to start the game',
                de: 'Führen Sie die .exe-Datei aus, um das Spiel zu starten',
                fr: 'Exécutez le fichier .exe pour démarrer le jeu',
                es: 'Ejecuta el archivo .exe para iniciar el juego',
                ru: 'Запустите .exe файл для запуска игры',
                zh: '运行.exe文件启动游戏',
                ja: '.exeファイルを実行してゲームを開始',
                it: 'Esegui il file .exe per avviare il gioco',
                pt: 'Execute o arquivo .exe para iniciar o jogo',
                ko: '.exe 파일을 실행하여 게임을 시작하세요',
                pl: 'Uruchom plik .exe, aby uruchomić grę',
                ar: 'شغل ملف .exe لبدء اللعبة',
                az: 'Oyunu başlatmaq üçün .exe faylını işə salın'
            },
            'important_notes': {
                tr: 'Önemli Notlar:',
                en: 'Important Notes:',
                de: 'Wichtige Hinweise:',
                fr: 'Notes importantes :',
                es: 'Notas importantes:',
                ru: 'Важные замечания:',
                zh: '重要提示：',
                ja: '重要な注意事項：',
                it: 'Note importanti:',
                pt: 'Notas importantes:',
                ko: '중요한 참고사항:',
                pl: 'Ważne uwagi:',
                ar: 'ملاحظات مهمة:',
                az: 'Vacib Qeydlər:'
            },
            'antivirus_warning': {
                tr: 'Antivirüs programınız oyunu yanlış algılayabilir',
                en: 'Your antivirus may incorrectly detect the game',
                de: 'Ihr Antivirus könnte das Spiel fälschlicherweise erkennen',
                fr: 'Votre antivirus peut détecter incorrectement le jeu',
                es: 'Tu antivirus puede detectar incorrectamente el juego',
                ru: 'Ваш антивирус может неправильно определить игру',
                zh: '您的杀毒软件可能会误报游戏',
                ja: 'アンチウイルスがゲームを誤検知する可能性があります',
                it: 'Il tuo antivirus potrebbe rilevare erroneamente il gioco',
                pt: 'Seu antivírus pode detectar incorretamente o jogo',
                ko: '바이러스 백신이 게임을 잘못 감지할 수 있습니다',
                pl: 'Twój program antywirusowy może błędnie wykryć grę',
                ar: 'قد يكتشف برنامج مكافحة الفيروسات اللعبة بشكل خاطئ',
                az: 'Antivirus proqramınız oyunu səhv aşkarlaya bilər'
            },
            'mark_as_trusted': {
                tr: 'Bu durumda oyunu güvenilir olarak işaretleyin',
                en: 'In this case, mark the game as trusted',
                de: 'Markieren Sie in diesem Fall das Spiel als vertrauenswürdig',
                fr: 'Dans ce cas, marquez le jeu comme fiable',
                es: 'En este caso, marca el juego como confiable',
                ru: 'В этом случае отметьте игру как доверенную',
                zh: '在这种情况下，将游戏标记为可信',
                ja: 'この場合、ゲームを信頼できるものとしてマークしてください',
                it: 'In questo caso, contrassegna il gioco come attendibile',
                pt: 'Neste caso, marque o jogo como confiável',
                ko: '이 경우 게임을 신뢰할 수 있는 것으로 표시하세요',
                pl: 'W takim przypadku oznacz grę jako zaufaną',
                ar: 'في هذه الحالة، حدد اللعبة كموثوقة',
                az: 'Bu halda oyunu etibarlı olaraq qeyd edin'
            },
            'visual_cpp_redistributable': {
                tr: 'Oyun çalışmazsa Visual C++ Redistributable yükleyin',
                en: 'If the game doesn\'t work, install Visual C++ Redistributable',
                de: 'Wenn das Spiel nicht funktioniert, installieren Sie Visual C++ Redistributable',
                fr: 'Si le jeu ne fonctionne pas, installez Visual C++ Redistributable',
                es: 'Si el juego no funciona, instala Visual C++ Redistributable',
                ru: 'Если игра не работает, установите Visual C++ Redistributable',
                zh: '如果游戏无法运行，请安装Visual C++ Redistributable',
                ja: 'ゲームが動作しない場合は、Visual C++ Redistributableをインストールしてください',
                it: 'Se il gioco non funziona, installa Visual C++ Redistributable',
                pt: 'Se o jogo não funcionar, instale o Visual C++ Redistributable',
                ko: '게임이 작동하지 않으면 Visual C++ Redistributable을 설치하세요',
                pl: 'Jeśli gra nie działa, zainstaluj Visual C++ Redistributable',
                ar: 'إذا لم تعمل اللعبة، قم بتثبيت Visual C++ Redistributable',
                az: 'Oyun işləməsə Visual C++ Redistributable yükləyin'
            },
            'directx_updates': {
                tr: 'DirectX güncellemeleri gerekebilir',
                en: 'DirectX updates may be required',
                de: 'DirectX-Updates könnten erforderlich sein',
                fr: 'Les mises à jour DirectX peuvent être nécessaires',
                es: 'Pueden ser necesarias actualizaciones de DirectX',
                ru: 'Могут потребоваться обновления DirectX',
                zh: '可能需要DirectX更新',
                ja: 'DirectXの更新が必要な場合があります',
                it: 'Potrebbero essere necessari aggiornamenti DirectX',
                pt: 'Atualizações do DirectX podem ser necessárias',
                ko: 'DirectX 업데이트가 필요할 수 있습니다',
                pl: 'Może być wymagane aktualizacja DirectX',
                ar: 'قد تكون تحديثات DirectX مطلوبة',
                az: 'DirectX yeniləmələri tələb oluna bilər'
            },
            'understood_close': {
                tr: 'Anladım, Kapat',
                en: 'Understood, Close',
                de: 'Verstanden, Schließen',
                fr: 'Compris, Fermer',
                es: 'Entendido, Cerrar',
                ru: 'Понятно, Закрыть',
                zh: '明白了，关闭',
                ja: '理解しました、閉じる',
                it: 'Capito, Chiudi',
                pt: 'Entendido, Fechar',
                ko: '이해했습니다, 닫기',
                pl: 'Rozumiem, Zamknij',
                ar: 'فهمت، إغلاق',
                az: 'Başa düşdüm, Bağla'
            }
        };
        return dict[key] && dict[key][lang] ? dict[key][lang] : dict[key]?.tr || key;
    }

    renderSettingsPage() {
        const settingsContainer = document.getElementById('settings-page');
        if (!settingsContainer) return;
        const currentVersion = (window?.process?.versions?.electron && window?.require?.main?.module?.exports) ? '' : '';
        settingsContainer.innerHTML = `
            <div class="language-select-label">${this.translate('language')}</div>
            <div class="language-select-list">
                ${Object.keys(languageFlagUrls).map(lang => `
                    <button class="lang-btn${this.getSelectedLang()===lang?' selected':''}" data-lang="${lang}">
                        <img class="flag" src="${languageFlagUrls[lang]}" alt="${lang} flag" width="28" height="20" style="border-radius:4px;box-shadow:0 1px 4px #0002;vertical-align:middle;" />
                        <span class="lang-name">${this.translate('lang_' + lang)}</span>
                    </button>
                `).join('')}
            </div>
            <div class="settings-section">
                <div class="settings-subtitle">${this.translate('app_settings')}</div>
                <label class="setting-item">
                    <input type="checkbox" id="discordRPCToggle" ${this.config.discordRPC ? 'checked' : ''}>
                    <span data-i18n="enable_discord">${this.translate('enable_discord')}</span>
                </label>
                <label class="setting-item">
                    <input type="checkbox" id="videoMutedToggle" ${this.config.videoMuted ? 'checked' : ''}>
                    <span data-i18n="mute_videos">${this.translate('mute_videos')}</span>
                </label>
                <br>
                <div id="versionRow" class="setting-item" style="display:flex;align-items:center;gap:8px;">
                    <span style="opacity:.8;">Sürüm:</span>
                    <span id="appVersion">Yükleniyor...</span>
                    <a id="releaseLink" href="#" target="_blank" style="margin-left:8px;color:#00bfff;">GitHub</a>
                </div>
            </div>
        `;
        
        // Dil seçici butonları için event listener'lar
        const langBtns = settingsContainer.querySelectorAll('.lang-btn');
        langBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const lang = btn.dataset.lang;
                this.setCurrentLanguage(lang);
            });
        });
        
        // Toggle eventleri
        const discordToggle = document.getElementById('discordRPCToggle');
        if (discordToggle) {
            discordToggle.addEventListener('change', (e) => {
                this.updateConfig({ discordRPC: e.target.checked });
            });
        }
        
        const videoToggle = document.getElementById('videoMutedToggle');
        if (videoToggle) {
            videoToggle.addEventListener('change', (e) => {
                this.updateConfig({ videoMuted: e.target.checked });
            });
        }

        // Versiyon bilgisini çek
        this.loadAndRenderVersionInfo();
    }

    async loadAndRenderVersionInfo() {
        try {
            const appVersionEl = document.getElementById('appVersion');
            const releaseLinkEl = document.getElementById('releaseLink');
            if (!appVersionEl || !releaseLinkEl) return;

			const headers = {
				'Accept': 'application/vnd.github+json',
				'User-Agent': 'ParadiseSteamLibrary'
			};

			let latestTag = null;
			let latestUrl = 'https://github.com/muhammetdag/ParadiseSteamLibrary/releases';

			// 1) Releases/latest dene
			try {
				const relResp = await fetch('https://api.github.com/repos/muhammetdag/ParadiseSteamLibrary/releases/latest', { headers, cache: 'no-store' });
				if (relResp.ok) {
					const data = await relResp.json();
					latestTag = data.tag_name || null;
					latestUrl = data.html_url || latestUrl;
				}
			} catch {}

			// 2) Düşüş: tags endpoint
			if (!latestTag) {
				try {
					const tagsResp = await fetch('https://api.github.com/repos/muhammetdag/ParadiseSteamLibrary/tags', { headers, cache: 'no-store' });
					if (tagsResp.ok) {
						const arr = await tagsResp.json();
						if (Array.isArray(arr) && arr.length > 0) {
							latestTag = arr[0]?.name || null;
						}
					}
				} catch {}
			}

			// UI'yi yaz
			appVersionEl.textContent = latestTag || 'v?';
			releaseLinkEl.href = latestUrl;

			// Yerel version ile karşılaştır
            // Yerel sürüm: main process'ten app.getVersion()
            let localVersion = await ipcRenderer.invoke('get-app-version');
            if (!localVersion) {
                try { localVersion = require('../../package.json').version; } catch {}
            }
            if (localVersion && latestTag) {
                const normalizedLocal = localVersion.toString().startsWith('v') ? localVersion : `v${localVersion}`;
                if (this.isSemverNewer(latestTag, normalizedLocal)) {
                    // Modal ile göster
                    const latestEl = document.getElementById('updateLatest');
                    const currentEl = document.getElementById('updateCurrent');
                    if (latestEl) latestEl.textContent = latestTag;
                    if (currentEl) currentEl.textContent = normalizedLocal;
                    const openBtn = document.getElementById('openReleaseBtn');
                    const laterBtn = document.getElementById('updateLaterBtn');
                    if (openBtn) {
                        openBtn.onclick = () => {
                            window.open('https://github.com/muhammetdag/ParadiseSteamLibrary/releases', '_blank');
                            this.closeModal('updateModal');
                        };
                    }
                    if (laterBtn) {
                        laterBtn.onclick = () => this.closeModal('updateModal');
                    }
                    this.showModal('updateModal');
                }
            }
		} catch (e) {
			const appVersionEl = document.getElementById('appVersion');
			const releaseLinkEl = document.getElementById('releaseLink');
			if (appVersionEl) appVersionEl.textContent = (window?.require ? require('../../package.json').version : 'v?');
			if (releaseLinkEl) releaseLinkEl.href = 'https://github.com/muhammetdag/ParadiseSteamLibrary/releases';
		}
    }

    // Basit semver karşılaştırma: vA.B.C biçimi bekler
    isSemverNewer(a, b) {
        const parse = (v) => {
            const m = (v || '').toString().replace(/^v/, '').match(/^(\d+)\.(\d+)\.(\d+)/);
            return m ? [parseInt(m[1]), parseInt(m[2]), parseInt(m[3])] : [0,0,0];
        };
        const [a1,a2,a3] = parse(a);
        const [b1,b2,b3] = parse(b);
        if (a1 !== b1) return a1 > b1;
        if (a2 !== b2) return a2 > b2;
        return a3 > b3;
    }

    setCurrentLanguage(lang) {
        localStorage.setItem('selectedLang', lang);
        this.renderSettingsPage();
        this.updateTranslations();
    }

    // DLC seçiminden sonra seçilen DLC'lerle oyunu ekle
    confirmGameWithDLCs(appId, selectedDLCs) {
        // addGameToLibrary fonksiyonunu DLC parametresiyle çağır
        this.addGameToLibraryWithDLCs(appId, selectedDLCs);
    }

    // DLC'li oyun ekleme fonksiyonu
    async addGameToLibraryWithDLCs(appId, selectedDLCs) {
        if (!this.config.steamPath) {
            this.showNotification('error', 'steam_path_failed', 'error');
            return;
        }
        // Oyun dosyası API kontrolü (404 ise oyun yok)
        try {
            const res = await fetch(`https://api.muhammetdag.com/steamlib/game/game.php?steamid=${appId}`);
            if (res.status === 404) {
                this.showNotification('error', 'game_not_found', 'error');
                return;
            }
        } catch {
            this.showNotification('error', 'game_not_found', 'error');
            return;
        }
        this.showLoading();
        try {
            const result = await ipcRenderer.invoke('add-game-to-library', appId, selectedDLCs);
            if (result.success) {
                this.showNotification('success', 'game_added', 'success');
                this.closeModal('dlcModal');
                this.showSteamRestartDialog();
            }
        } catch (error) {
            console.error('Failed to add game:', error);
            this.showNotification('error', 'game_add_failed', 'error');
        } finally {
            this.hideLoading();
        }
    }

    async loadOnlinePassGames() {
        const cc = this.countryCode || 'TR';
        const lang = this.getSelectedLang();
        const onlineGrid = document.getElementById('onlinePassPage');
        if (!onlineGrid) return;
        // Önce mevcut interval/async durumlarını sıfırla
        this.onlinePassCurrentPage = 0;
        // Yinelenen grid eklenmesini engellemek için önce temizle
        onlineGrid.innerHTML = '';
        
        onlineGrid.innerHTML = `<div class='page-header' style='width:100%;display:flex;justify-content:center;align-items:center;margin-bottom:24px;'><h1 style='font-size:2.2rem;font-weight:800;color:#00bfff;display:inline-block;'>${this.translate('online_pass')}</h1></div><div style="color:#fff;padding:16px;">${this.translate('online_games_loading')}</div>`;
        
        try {
            // Yeni API endpoint'ini kullan
            const res = await fetch('https://api.muhammetdag.com/steamlib/online/online_fix_games.json', { cache: 'no-store' });
            const data = await res.json();
            
            if (!Array.isArray(data)) {
                throw new Error('Online oyun listesi alınamadı');
            }
            
            // Oyunları appid'ye göre düzenle ve null değerleri filtrele
            this.onlinePassGames = data
                .map(game => game.appid)
                .filter(appid => appid != null && appid !== undefined && appid !== '');
            this.onlinePassFilteredGames = this.onlinePassGames;
            this.onlinePassCurrentPage = 0;
            
            // Önce oyunları ID'lerle göster, sonra isimleri arka planda yükle
            this.renderOnlinePassGames();
            
            // Oyun isimlerini arka planda önbellekle (lazy loading)
            this.cacheOnlineGameNames().then(() => {
                // İsimler yüklendikten sonra sayfayı yeniden render et
                this.renderOnlinePassGames();
                // Loading mesajını kaldır
                const loadingMsg = onlineGrid.querySelector('.loading-names');
                if (loadingMsg) loadingMsg.remove();
            }).catch(error => {
                console.error('Error caching game names:', error);
                // Hata durumunda loading mesajını kaldır
                const loadingMsg = onlineGrid.querySelector('.loading-names');
                if (loadingMsg) loadingMsg.remove();
            });
            
            // Loading mesajı ekle
            const loadingMsg = document.createElement('div');
            loadingMsg.className = 'loading-names';
            loadingMsg.style.cssText = 'color:#00bfff;padding:8px;text-align:center;font-size:14px;';
            loadingMsg.textContent = 'Oyun isimleri yükleniyor...';
            onlineGrid.appendChild(loadingMsg);
            
        } catch (err) {
            console.error('Error loading online pass games:', err);
            onlineGrid.innerHTML = `<div style='color:#fff;padding:16px;'>${this.translate('online_games_load_failed')}: ${err.message}</div>`;
        }
    }



    async renderOnlinePassGames(list) {
        const onlineGrid = document.getElementById('onlinePassPage');
        if (!onlineGrid) return;
        
        // Sayfa başlığını oluştur
        onlineGrid.innerHTML = `<div class='page-header' style='width:100%;display:flex;justify-content:center;align-items:center;margin-bottom:24px;'><h1 style='font-size:2.2rem;font-weight:800;color:#00bfff;display:inline-block;'>${this.translate('online_pass')}</h1></div>`;
        
        // Filtrelenmiş oyunları kullan (list parametresi artık kullanılmıyor)
        const games = this.onlinePassFilteredGames;
        if (!games || games.length === 0) {
            onlineGrid.innerHTML += `<div style='color:#fff;padding:16px;'>${this.translate('no_online_games')}.</div>`;
            return;
        }
        
        // Sayfalama hesaplamaları
        const startIndex = this.onlinePassCurrentPage * this.onlinePassGamesPerPage;
        const endIndex = startIndex + this.onlinePassGamesPerPage;
        const currentPageGames = games.slice(startIndex, endIndex);
        const totalPages = Math.ceil(games.length / this.onlinePassGamesPerPage);
        
        // Oyun grid'ini oluştur (id ile tekil)
        const existing = document.getElementById('online-pass-grid');
        if (existing) existing.remove();
        const grid = document.createElement('div');
        grid.className = 'online-pass-grid';
        grid.id = 'online-pass-grid';
        grid.style.padding = '24px 0 0 0';
        
        // Oyun kartlarını asenkron olarak oluştur
        const createGameCard = async (gameId) => {
            // Null kontrolü
            if (!gameId) {
                console.warn('Skipping null gameId in createGameCard');
                return null;
            }
            
            const card = document.createElement('div');
            card.className = 'game-card';
            card.style.background = '#181c22';
            card.style.borderRadius = '14px';
            card.style.cursor = 'pointer';
            card.style.boxShadow = '0 2px 12px #0002';
            
            try {
                let gameName = `Oyun ID: ${gameId}`;
                let imageUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${gameId}/header.jpg`;
                
                // Önce cache'den isim kontrol et
                if (this.onlinePassGameNames && this.onlinePassGameNames[gameId]) {
                    gameName = this.onlinePassGameNames[gameId];
                } else {
                    // Cache'de yoksa Steam API'den çek (sadece gerekirse)
                    try {
                        const steamResponse = await safeSteamFetch(`https://store.steampowered.com/api/appdetails?appids=${gameId}&l=turkish`);
                        const steamData = await steamResponse.json();
                        
                        if (steamData[gameId] && steamData[gameId].success && steamData[gameId].data) {
                            const gameData = steamData[gameId].data;
                            gameName = gameData.name || gameName;
                            imageUrl = gameData.header_image || imageUrl;
                        }
                    } catch (steamError) {
                        console.warn(`Could not fetch Steam data for game ${gameId}:`, steamError);
                    }
                }
                
                const steamUrl = `https://store.steampowered.com/app/${gameId}`;
                
                card.innerHTML = `
                    <img src="${imageUrl}" alt="${gameName}" class="game-image" loading="lazy" style="width:100%;height:160px;object-fit:cover;border-radius:12px 12px 0 0;" onerror="this.onerror=null;this.src='pdbanner.png'">
                    <div class="game-info" style="padding:12px;">
                        <h3 class="game-title" style="font-size:18px;font-weight:700;margin-bottom:4px;">${gameName}</h3>
                        <div class="game-meta" style="margin-bottom:6px;">
                            <span style="color:#00bfff;font-size:12px;">${this.translate('online_pass')}</span>
                        </div>
                        <button class="game-btn primary" style="width:100%;margin-top:8px;" onclick="ui.downloadOnlineGame(${gameId})">${this.translate('online_add')}</button>
                        <button class="game-btn secondary" style="width:100%;margin-top:8px;background:#222;color:#00bfff;border:1px solid #00bfff;" onclick="event.stopPropagation(); window.open('${steamUrl}','_blank')">${this.translate('steam_page')}</button>
                    </div>
                `;
            } catch (error) {
                // Hata durumunda basit kart göster
                const steamUrl = `https://store.steampowered.com/app/${gameId}`;
                const imageUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${gameId}/header.jpg`;
                
                card.innerHTML = `
                    <img src="${imageUrl}" alt="Game ${gameId}" class="game-image" loading="lazy" style="width:100%;height:160px;object-fit:cover;border-radius:12px 12px 0 0;" onerror="this.onerror=null;this.src='pdbanner.png'">
                    <div class="game-info" style="padding:12px;">
                        <h3 class="game-title" style="font-size:18px;font-weight:700;margin-bottom:4px;">${this.translate('game_id')}: ${gameId}</h3>
                        <div class="game-meta" style="margin-bottom:6px;">
                            <span style="color:#00bfff;font-size:12px;">${this.translate('online_pass')}</span>
                        </div>
                        <button class="game-btn primary" style="width:100%;margin-top:8px;" onclick="ui.downloadOnlineGame(${gameId})">${this.translate('online_add')}</button>
                        <button class="game-btn secondary" style="width:100%;margin-top:8px;background:#222;color:#00bfff;border:1px solid #00bfff;" onclick="event.stopPropagation(); window.open('${steamUrl}','_blank')">${this.translate('steam_page')}</button>
                    </div>
                `;
            }
            
            return card;
        };

        // Oyun kartlarını paralel olarak oluştur
        const cardPromises = currentPageGames.map(game => createGameCard(game));
        const cards = await Promise.all(cardPromises);
        
        // Null kartları filtrele
        cards.filter(card => card !== null).forEach(card => {
            grid.appendChild(card);
        });
        onlineGrid.appendChild(grid);
        
        // Sayfalama kontrollerini ekle
        if (totalPages > 1) {
            const paginationContainer = document.createElement('div');
            paginationContainer.style.display = 'flex';
            paginationContainer.style.justifyContent = 'center';
            paginationContainer.style.alignItems = 'center';
            paginationContainer.style.gap = '12px';
            paginationContainer.style.marginTop = '32px';
            paginationContainer.style.padding = '16px';
            
            // Önceki sayfa butonu
            const prevBtn = document.createElement('button');
            prevBtn.textContent = this.translate('previous_page');
            prevBtn.style.padding = '8px 16px';
            prevBtn.style.background = this.onlinePassCurrentPage > 0 ? '#00bfff' : '#444';
            prevBtn.style.color = '#fff';
            prevBtn.style.border = 'none';
            prevBtn.style.borderRadius = '6px';
            prevBtn.style.cursor = this.onlinePassCurrentPage > 0 ? 'pointer' : 'not-allowed';
            prevBtn.onclick = () => {
                if (this.onlinePassCurrentPage > 0) {
                    this.onlinePassCurrentPage--;
                    this.renderOnlinePassGames();
                }
            };
            
            // Sayfa bilgisi
            const pageInfo = document.createElement('span');
            const pageInfoText = this.translate('page_info')
                .replace('{current}', this.onlinePassCurrentPage + 1)
                .replace('{total}', totalPages)
                .replace('{count}', games.length);
            pageInfo.textContent = pageInfoText;
            pageInfo.style.color = '#fff';
            pageInfo.style.fontSize = '14px';
            
            // Sonraki sayfa butonu
            const nextBtn = document.createElement('button');
            nextBtn.textContent = this.translate('next_page');
            nextBtn.style.padding = '8px 16px';
            nextBtn.style.background = this.onlinePassCurrentPage < totalPages - 1 ? '#00bfff' : '#444';
            nextBtn.style.color = '#fff';
            nextBtn.style.border = 'none';
            nextBtn.style.borderRadius = '6px';
            nextBtn.style.cursor = this.onlinePassCurrentPage < totalPages - 1 ? 'pointer' : 'not-allowed';
            nextBtn.onclick = () => {
                if (this.onlinePassCurrentPage < totalPages - 1) {
                    this.onlinePassCurrentPage++;
                    this.renderOnlinePassGames();
                }
            };
            
            paginationContainer.appendChild(prevBtn);
            paginationContainer.appendChild(pageInfo);
            paginationContainer.appendChild(nextBtn);
            onlineGrid.appendChild(paginationContainer);
        }
        

    }

    getCurrentPage() {
        const active = document.querySelector('.page.active');
        if (!active) return null;
        return active.id.replace('Page', '');
    }

    async downloadOnlineGame(appId) {
        try {
            this.showLoading();
            this.showNotification('info', 'Dosya indiriliyor...', 'info');
            
            // Ana sürece dosya indirme isteği gönder
            await ipcRenderer.invoke('download-online-file', appId);
            
            // İndirme başarılı olduğunda bilgilendirme mesajı göster
            this.showManualInstallInfo();
            
            this.showNotification('success', this.translate('download_success'), 'success');
        } catch (err) {
            console.error('Download error:', err);
            
            // Hata mesajını daha detaylı göster
            let errorMessage = err.message || err;
            
            if (errorMessage.includes('ZIP ayıklama başarısız')) {
                errorMessage = 'ZIP dosyası ayıklanamadı. Dosya bozuk olabilir.';
            } else if (errorMessage.includes('Dosya indirme hatası')) {
                errorMessage = 'Dosya indirilemedi. İnternet bağlantınızı kontrol edin.';
            }
            
            this.showNotification('error', errorMessage, 'error');
        } finally {
            this.hideLoading();
        }
    }

    showManualInstallInfo() {
        // Manuel kurulum bilgilendirme modal'ı oluştur
        const modalHtml = `
            <div class="modal-overlay active" id="manualInstallInfoModal">
                <div class="modal-container">
                    <div class="modal-header">
                        <h2>${this.translate('manual_install_required')}</h2>
                        <button class="modal-close" onclick="ui.closeManualInstallInfo()">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                            </svg>
                        </button>
                    </div>
                    <div class="modal-content">
                        <div style="text-align: center; margin-bottom: 20px;">
                            <div style="font-size: 48px; margin-bottom: 10px;">📦</div>
                            <h3 style="color: #00bfff; margin-bottom: 15px;">${this.translate('game_downloaded_successfully')}</h3>
                        </div>
                        
                        <div style="background: rgba(0, 191, 255, 0.1); border: 1px solid #00bfff; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
                            <h4 style="color: #00bfff; margin-bottom: 10px;">📋 ${this.translate('manual_install_steps')}</h4>
                            <ol style="text-align: left; margin: 0; padding-left: 20px;">
                                <li>${this.translate('find_downloaded_zip')}</li>
                                <li>${this.translate('right_click_extract')}</li>
                                <li><strong>${this.translate('zip_password')} <span style="color: #00bfff; font-weight: bold;">online-fix.me</span></strong></li>
                                <li>${this.translate('open_extracted_folder')}</li>
                                <li>${this.translate('copy_game_files')}</li>
                                <li>${this.translate('run_exe_file')}</li>
                            </ol>
                        </div>
                        
                        <div style="background: rgba(255, 193, 7, 0.1); border: 1px solid #ffc107; border-radius: 8px; padding: 15px; margin-bottom: 20px;">
                            <h4 style="color: #ffc107; margin-bottom: 10px;">⚠️ ${this.translate('important_notes')}</h4>
                            <ul style="text-align: left; margin: 0; padding-left: 20px;">
                                <li>${this.translate('antivirus_warning')}</li>
                                <li>${this.translate('mark_as_trusted')}</li>
                                <li>${this.translate('visual_cpp_redistributable')}</li>
                                <li>${this.translate('directx_updates')}</li>
                            </ul>
                        </div>
                        
                        <div style="text-align: center;">
                            <button class="btn btn-primary" onclick="ui.closeManualInstallInfo()" style="background: #00bfff; border: none; padding: 12px 24px; border-radius: 6px; color: white; font-weight: bold; cursor: pointer;">
                                ${this.translate('understood_close')}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        // Modal'ı sayfaya ekle
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        
        // Modal'ı kapatmak için ESC tuşu
        const modal = document.getElementById('manualInstallInfoModal');
        modal.onkeydown = (e) => {
            if (e.key === 'Escape') {
                this.closeManualInstallInfo();
            }
        };
        
        // Modal'a focus ver
        setTimeout(() => { modal.focus && modal.focus(); }, 200);
    }

    closeManualInstallInfo() {
        const modal = document.getElementById('manualInstallInfoModal');
        if (modal) {
            modal.remove();
        }
    }



    async getGameImageUrl(appId, gameName) {
        // Önce CDN'den görsel almaya çalış (daha hızlı)
        const cdnUrl = `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`;
        
        try {
            const imgResponse = await fetch(cdnUrl, { method: 'HEAD' });
            if (imgResponse.ok) {
                return cdnUrl;
            }
        } catch (error) {
            console.log(`CDN'den görsel alınamadı: ${appId}`, error);
        }
        
        // CDN'den alamazsa Steam API'den dene
        try {
            const response = await safeSteamFetch(`https://store.steampowered.com/api/appdetails?appids=${appId}`);
            const data = await response.json();
            
            if (data[appId] && data[appId].success && data[appId].data) {
                const gameData = data[appId].data;
                
                // Önce header_image'i dene
                if (gameData.header_image) {
                    return gameData.header_image;
                }
                
                // Sonra capsule_image'i dene
                if (gameData.capsule_image) {
                    return gameData.capsule_image;
                }
            }
        } catch (error) {
            console.log(`Steam API'den görsel alınamadı: ${appId}`, error);
        }
        
        // Hiçbiri çalışmazsa varsayılan görsel
        return 'pdbanner.png';
    }

    setupManualInstallListeners() {
        // Önce eski event listener'ları temizle
        this.cleanupManualInstallListeners();
        
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('gameFileInput');
        const selectFileBtn = document.getElementById('selectFileBtn');
        const installGameBtn = document.getElementById('installGameBtn');

        if (uploadArea) {
            // Dosya seçme butonu
            this.manualUploadAreaHandler = () => {
                fileInput.click();
            };
            uploadArea.addEventListener('click', this.manualUploadAreaHandler);

            // Drag and drop olayları
            this.manualDragOverHandler = (e) => {
                e.preventDefault();
                uploadArea.classList.add('dragover');
            };
            uploadArea.addEventListener('dragover', this.manualDragOverHandler);

            this.manualDragLeaveHandler = () => {
                uploadArea.classList.remove('dragover');
            };
            uploadArea.addEventListener('dragleave', this.manualDragLeaveHandler);

            this.manualDropHandler = (e) => {
                e.preventDefault();
                uploadArea.classList.remove('dragover');
                const files = e.dataTransfer.files;
                if (files.length > 0) {
                    this.handleFileSelect(files[0]);
                }
            };
            uploadArea.addEventListener('drop', this.manualDropHandler);
        }

        if (selectFileBtn) {
            this.manualSelectFileHandler = (e) => {
                e.stopPropagation();
                fileInput.click();
            };
            selectFileBtn.addEventListener('click', this.manualSelectFileHandler);
        }

        if (fileInput) {
            this.manualFileInputHandler = (e) => {
                if (e.target.files.length > 0) {
                    this.handleFileSelect(e.target.files[0]);
                }
            };
            fileInput.addEventListener('change', this.manualFileInputHandler);
        }

        if (installGameBtn) {
            this.manualInstallGameHandler = () => {
                this.installManualGame();
            };
            installGameBtn.addEventListener('click', this.manualInstallGameHandler);
        }
    }

    cleanupManualInstallListeners() {
        const uploadArea = document.getElementById('uploadArea');
        const fileInput = document.getElementById('gameFileInput');
        const selectFileBtn = document.getElementById('selectFileBtn');
        const installGameBtn = document.getElementById('installGameBtn');

        if (uploadArea && this.manualUploadAreaHandler) {
            uploadArea.removeEventListener('click', this.manualUploadAreaHandler);
            uploadArea.removeEventListener('dragover', this.manualDragOverHandler);
            uploadArea.removeEventListener('dragleave', this.manualDragLeaveHandler);
            uploadArea.removeEventListener('drop', this.manualDropHandler);
        }

        if (selectFileBtn && this.manualSelectFileHandler) {
            selectFileBtn.removeEventListener('click', this.manualSelectFileHandler);
        }

        if (fileInput && this.manualFileInputHandler) {
            fileInput.removeEventListener('change', this.manualFileInputHandler);
        }

        if (installGameBtn && this.manualInstallGameHandler) {
            installGameBtn.removeEventListener('click', this.manualInstallGameHandler);
        }
    }

    async handleFileSelect(file) {
        if (!file.name.toLowerCase().endsWith('.zip')) {
            this.showNotification('error', 'only_zip_supported', 'error');
            return;
        }

        // Dosya bilgilerini göster
        const fileSize = (file.size / (1024 * 1024)).toFixed(2);
        const uploadArea = document.getElementById('uploadArea');
        
        uploadArea.innerHTML = `
            <div class="file-info">
                <h4>${this.translate('selected_file')}</h4>
                <p><strong>${this.translate('file_name')}:</strong> ${file.name}</p>
                <p><strong>${this.translate('size')}:</strong> ${fileSize} MB</p>
                <button class="upload-btn" id="selectAnotherFileBtn">${this.translate('select_another_file')}</button>
            </div>
        `;
        
        // Yeni butona event listener ekle
        const selectAnotherFileBtn = document.getElementById('selectAnotherFileBtn');
        if (selectAnotherFileBtn) {
            selectAnotherFileBtn.addEventListener('click', () => {
                this.selectNewFile();
            });
        }

        // Oyun bilgileri formunu göster
        document.getElementById('gameInfoSection').style.display = 'block';
        document.getElementById('installActions').style.display = 'block';

        // Dosyayı sakla
        this.selectedFile = file;

        // ZIP dosyasından oyun bilgilerini çek
        try {
            const gameInfo = await this.extractGameInfoFromZip(file);
            document.getElementById('gameNameDisplay').textContent = gameInfo.name || 'Bilinmeyen Oyun';
            document.getElementById('gameIdDisplay').textContent = gameInfo.appId || 'Bilinmeyen ID';
        } catch (error) {
            console.error('Failed to extract game info:', error);
            document.getElementById('gameNameDisplay').textContent = 'Bilinmeyen Oyun';
            document.getElementById('gameIdDisplay').textContent = 'Bilinmeyen ID';
        }
    }

    selectNewFile() {
        document.getElementById('gameFileInput').click();
    }

    async extractGameInfoFromZip(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = async (e) => {
                try {
                    const arrayBuffer = e.target.result;
                    const zip = await JSZip.loadAsync(arrayBuffer);
                    
                    // ZIP içindeki dosyaları kontrol et
                    const files = Object.keys(zip.files);
                    
                    // .lua dosyalarını ara (oyun ID'si için)
                    const luaFiles = files.filter(name => name.endsWith('.lua'));
                    let appId = null;
                    
                    for (const luaFile of luaFiles) {
                        const fileName = luaFile.split('/').pop().replace('.lua', '');
                        if (/^\d+$/.test(fileName)) {
                            appId = fileName;
                            break;
                        }
                    }
                    
                    // App ID'den oyun adını çek
                    let gameName = 'Bilinmeyen Oyun';
                    if (appId) {
                        try {
                            const gameDetails = await ipcRenderer.invoke('fetch-game-details', appId);
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
                } catch (error) {
                    reject(error);
                }
            };
            reader.onerror = reject;
            reader.readAsArrayBuffer(file);
        });
    }



    async installManualGame() {
        if (!this.selectedFile) {
            this.showNotification('error', 'please_select_file', 'error');
            return;
        }

        this.showLoading();
        try {
            const result = await ipcRenderer.invoke('install-manual-game', {
                file: this.selectedFile.path
            });

            if (result.success) {
                this.showNotification('success', 'game_installed_successfully', 'success');
                this.resetManualInstallForm();
            } else {
                this.showNotification('error', result.error || 'installation_failed', 'error');
            }
        } catch (error) {
            console.error('Failed to install manual game:', error);
            this.showNotification('error', 'installation_error', 'error');
        } finally {
            this.hideLoading();
        }
    }

    resetManualInstallForm() {
        // Event listener'ları temizle
        this.cleanupManualInstallListeners();
        
        // Formu sıfırla
        document.getElementById('gameInfoSection').style.display = 'none';
        document.getElementById('installActions').style.display = 'none';
        
        // Upload alanını geri yükle
        const uploadArea = document.getElementById('uploadArea');
        uploadArea.innerHTML = `
            <div class="upload-icon">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7,10 12,15 17,10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
            </div>
            <h3 data-i18n="upload_game_file">Oyun Dosyasını Yükle</h3>
            <p data-i18n="drag_drop_zip">ZIP dosyasını buraya sürükleyip bırakın veya tıklayarak seçin</p>
            <input type="file" id="gameFileInput" accept=".zip" style="display:none;">
            <button class="upload-btn" id="selectFileBtn" data-i18n="select_file">Dosya Seç</button>
        `;
        
        this.selectedFile = null;
        this.setupManualInstallListeners();
    }

    // Online Pass arama fonksiyonu
    handleOnlinePassSearch(query) {
        if (!this.onlinePassGames) return;
        
        if (!query || query.trim() === '') {
            // Arama boşsa tüm oyunları göster
            this.onlinePassFilteredGames = this.onlinePassGames;
        } else {
            // Arama yap
            const searchTerm = query.toLowerCase().trim();
            this.onlinePassFilteredGames = this.onlinePassGames.filter(gameId => {
                // Null kontrolü
                if (!gameId) return false;
                
                // ID ile arama (her zaman çalışır)
                try {
                    if (gameId.toString().includes(searchTerm)) {
                        return true;
                    }
                } catch (error) {
                    console.error('Error converting gameId to string:', error);
                    return false;
                }
                
                // İsim ile arama (önbellekten - eğer varsa)
                if (this.onlinePassGameNames && this.onlinePassGameNames[gameId]) {
                    try {
                        const gameName = this.onlinePassGameNames[gameId].toLowerCase();
                        return gameName.includes(searchTerm);
                    } catch (error) {
                        console.error('Error processing game name:', error);
                        return false;
                    }
                } else {
                    // İsimler henüz yüklenmemişse, sadece ID ile arama yap
                    // Bu sayede arama hemen çalışır
                }
                
                return false;
            });
        }
        
        // Sayfa sıfırla ve yeniden render et
        this.onlinePassCurrentPage = 0;
        this.renderOnlinePassGames();
    }

    // Online oyun isimlerini önbellekle
    async cacheOnlineGameNames() {
        if (!this.onlinePassGames) return;
        if (this.onlinePassGameNames) return;
        
        this.onlinePassGameNames = {};
        
        // Tüm oyun isimlerini paralel olarak çek (rate limiting ile)
        const batchSize = 5; // Aynı anda en fazla 5 istek
        const delay = 1200; // Her batch arasında 1.2s bekle
        
        for (let i = 0; i < this.onlinePassGames.length; i += batchSize) {
            const batch = this.onlinePassGames.slice(i, i + batchSize);
            
            const batchPromises = batch.map(async (gameId) => {
                // Null kontrolü
                if (!gameId) {
                    console.warn('Skipping null gameId in cacheOnlineGameNames');
                    return;
                }
                
                try {
                    // Önce kalıcı cache'i kontrol et
                    if (this.onlinePassNameCache && this.onlinePassNameCache[gameId]) {
                        this.onlinePassGameNames[gameId] = this.onlinePassNameCache[gameId];
                        return;
                    }
                    // 403'lerde geri çekilmek için geçici backoff uygula
                    const now = Date.now();
                    if (this.appDetailsBackoffUntil && now < this.appDetailsBackoffUntil) {
                        // backoff süresinde istek atma, sadece ID bırak
                        this.onlinePassGameNames[gameId] = `${this.translate('game_id')}: ${gameId}`;
                        return;
                    }
                    // Güvenli detay çekme
                    const gameData = await fetchSteamAppDetails(gameId, this.countryCode || 'TR', 'turkish');
                    
                    if (gameData && gameData.name) {
                        this.onlinePassGameNames[gameId] = gameData.name;
                        this.onlinePassNameCache[gameId] = gameData.name;
                        this.appDetailsConsecutiveNulls = 0; // sıfırla
                    } else {
                        this.onlinePassGameNames[gameId] = `${this.translate('game_id')}: ${gameId}`;
                        this.appDetailsConsecutiveNulls++;
                    }
                } catch (error) {
                    console.error('Error caching game name:', error);
                    this.onlinePassGameNames[gameId] = `${this.translate('game_id')}: ${gameId}`;
                    this.appDetailsConsecutiveNulls++;
                }
            });
            
            await Promise.all(batchPromises);
            this.persistOnlinePassNameCache();
            
            // Son batch değilse bekle
            if (i + batchSize < this.onlinePassGames.length) {
                // Eğer art arda 403 nedeniyle veri alamıyorsak backoff uygula
                if (this.appDetailsConsecutiveNulls >= batchSize) {
                    this.appDetailsBackoffUntil = Date.now() + 60_000; // 60s bekle
                    this.appDetailsConsecutiveNulls = 0; // sayaç sıfırla
                }
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    // Test ZIP extraction function - Debugging için
    async testZipExtraction(zipPath, targetDir) {
      try {
        console.log('Testing ZIP extraction...');
        console.log('ZIP Path:', zipPath);
        console.log('Target Directory:', targetDir);
        
        const result = await ipcRenderer.invoke('test-zip-extraction', zipPath, targetDir);
        
        if (result.success) {
          this.showNotification('success', 'ZIP extraction test successful!', 'success');
          console.log('Test result:', result);
        } else {
          this.showNotification('error', `ZIP extraction test failed: ${result.error}`, 'error');
          console.error('Test result:', result);
        }
        
        return result;
      } catch (error) {
        console.error('Test function error:', error);
        this.showNotification('error', `Test function error: ${error.message}`, 'error');
        return { success: false, error: error.message };
      }
    }

    setupActiveUsersTracking() {
        // IPC listener'ları ayarla
        ipcRenderer.on('update-active-users', (event, count) => {
            this.updateActiveUsersDisplay(count);
        });

        this.refreshActiveUsersCount();
        
        // Her 60 saniyede bir aktif kullanıcı sayısını güncelle (daha az istek)
        this.activeUsersInterval = setInterval(() => {
            if (document.hidden) return;
            this.refreshActiveUsersCount();
        }, 60000);
    }

    async refreshActiveUsersCount() {
        try {
            const count = await ipcRenderer.invoke('refresh-active-users');
            this.updateActiveUsersDisplay(count);
        } catch (error) {
            console.error('Aktif kullanıcı sayısı alınamadı:', error);
            this.updateActiveUsersDisplay(0);
        }
    }

    updateActiveUsersDisplay(count) {
        const countElement = document.getElementById('activeUsersCount');
        const indicator = document.getElementById('activeUsersIndicator');
        
        if (countElement && indicator) {
            if (count === 0 || count === null || count === undefined) {
                countElement.textContent = '-';
                indicator.style.opacity = '0.5';
            } else {
                countElement.textContent = count;
                indicator.style.opacity = '1';
                
                // Animasyon efekti
                indicator.style.transform = 'scale(1.1)';
                setTimeout(() => {
                    indicator.style.transform = 'scale(1)';
                }, 200);
            }
      }
    }
    
}

// Global test function for console access
window.testZipExtraction = (zipPath, targetDir) => {
  return ui.testZipExtraction(zipPath, targetDir);
};

// Global manual install info functions
window.closeManualInstallInfo = () => {
  ui.closeManualInstallInfo();
};

// Initialize the application
const ui = new SteamLibraryUI();

// Tüm metinleri güncelleyen fonksiyon (her sayfa ve modal için)
function renderAllTexts() {
  // data-i18n ile işaretlenmiş tüm elemanları güncelle
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) {
      el.textContent = ui.translate(key);
    }
  });
  // data-i18n-placeholder ile işaretlenmiş input/textarea'ların placeholder'ını güncelle
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) {
      el.setAttribute('placeholder', ui.translate(key));
    }
  });
  // data-i18n-title ile işaretlenmiş elemanların title'ını güncelle
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (key) {
      el.setAttribute('title', ui.translate(key));
    }
  });
}

// Sayfa değişimlerinde ve dil değişiminde otomatik çağrılacak şekilde ayarla
const originalSwitchPage = SteamLibraryUI.prototype.switchPage;
SteamLibraryUI.prototype.switchPage = function(page) {
  originalSwitchPage.call(this, page);
  renderAllTexts();
};

// Sayfa yüklendiğinde eski sabit dil seçiciyi DOM'dan kaldır
window.addEventListener('DOMContentLoaded', () => {
  const oldSelector = document.getElementById('languageSelector');
  if (oldSelector) oldSelector.remove();
  ui.renderSettingsPage();
  renderAllTexts();
});

// Bayrak PNG URL'leri globalde kalsın
const languageFlagUrls = {
  tr: "https://flagcdn.com/w40/tr.png",
  en: "https://flagcdn.com/w40/gb.png",
  de: "https://flagcdn.com/w40/de.png",
  fr: "https://flagcdn.com/w40/fr.png",
  ru: "https://flagcdn.com/w40/ru.png",
  es: "https://flagcdn.com/w40/es.png",
  it: "https://flagcdn.com/w40/it.png",
  pt: "https://flagcdn.com/w40/pt.png",
  ja: "https://flagcdn.com/w40/jp.png",
  ko: "https://flagcdn.com/w40/kr.png",
  zh: "https://flagcdn.com/w40/cn.png",
  pl: "https://flagcdn.com/w40/pl.png",
  az: "https://flagcdn.com/w40/az.png",
};

// Dil-kodundan ülke kodu eşlemesi
const langToCountry = {
  tr: 'TR', en: 'US', de: 'DE', fr: 'FR', es: 'ES', ru: 'RU', zh: 'CN', ja: 'JP', it: 'IT', pt: 'PT', ko: 'KR', pl: 'PL', az: 'AZ'
};

// Yardımcı fonksiyon: Steam API'ye güvenli fetch
async function safeSteamFetch(url) {
    // 200ms gecikme
    await new Promise(r => setTimeout(r, 200));
    try {
        return await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
    } catch (e) {
        // fallback: User-Agent olmadan tekrar dene
        return await fetch(url);
    }
}

// Tüm Oyunlar ve filtreleme ile ilgili fonksiyonlar kaldırıldı
