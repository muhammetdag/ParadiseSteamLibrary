const { ipcRenderer } = require('electron');

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

async function fetchSteamAppDetails(appid, cc, lang) {
    try {
        let url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&l=${lang}`;
        let res = await safeSteamFetch(url, { timeout: 15000 });

        if (res.status === 403 && !(cc === 'TR' && lang === 'turkish')) {
            await new Promise(r => setTimeout(r, 400));
            res = await safeSteamFetch(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=TR&l=turkish`, { timeout: 15000 });
        }

        if (!res.ok) return null;

        try {
            const data = await res.json();
            return data[appid]?.data || null;
        } catch {
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
        this.config = {
                    notificationDuration: 3,
            notificationAnimation: 'slide',
            notificationStyle: 'modern',
            notificationVolume: 100
        };
        this.restartCountdown = null;
        this.searchTimeout = null;
        this.countryCode = null;
        this.aiApiKey = "paradise5mZnb9oAWmBPXwFmvH1clfwnBFEeg4xDWh9PBFH0GF0ng1C6bNOTdLBW";
        this.aiApiUrl = "https://paradise-ai.vercel.app/api/app.js";
        this.aiHistory = [];
        this.appDetailsCache = {};
        

        this.steamApiCache = new Map();
        this.steamApiCacheExpiry = 3600000; // 1 saat
        
        this.appDetailsConsecutiveNulls = 0;
        this.appDetailsBackoffUntil = 0;
        
        
        
        window.ui = this;
        
        this.setupIpcListeners();
        
        this.init();
    }

    getPlaceholderImage() {
        return 'pdbanner.png';
    }

    getCurrentPage() {
        return this.currentPage || 'home';
    }

    updateSearchBarForPage() {
        const searchInput = document.getElementById('searchInput');
        const searchBtn = document.getElementById('searchBtn');
        
        if (!searchInput || !searchBtn) return;
        
        const currentPage = this.getCurrentPage();
        

        switch (currentPage) {
            case 'home':
                searchInput.placeholder = this.translate('search_placeholder');
                searchBtn.textContent = this.translate('search');
                break;
            case 'repairFix':
                searchInput.placeholder = this.translate('search_online_fixes');
                searchBtn.textContent = this.translate('search_online_fixes');
                break;
            case 'bypass':
                searchInput.placeholder = this.translate('search_bypass_games');
                searchBtn.textContent = this.translate('search_bypass');
                break;
            case 'library':
                searchInput.placeholder = this.translate('search_library');
                searchBtn.textContent = this.translate('search_library');
                break;
            default:
                searchInput.placeholder = this.translate('search_placeholder');
                searchBtn.textContent = this.translate('search');
                break;
        }
        

        searchInput.value = '';
        
        console.log(`🔍 Arama barı güncellendi: ${currentPage} sayfası için`);
    }

    setupIpcListeners() {
        ipcRenderer.on('steam-setup-status-updated', (event, steamSetupStatus) => {
            console.log('Steam setup status updated:', steamSetupStatus);
            
            if (steamSetupStatus.hasHidDll && steamSetupStatus.hasSteamPath) {
                const steamWarningModal = document.querySelector('.modal-overlay.steam-setup-warning');
                if (steamWarningModal) {
                    steamWarningModal.remove();
                }
            }
            
            this.handleSteamSetupWarnings(steamSetupStatus);
        });
    }

    async isLoggedIn() {
        console.log('isLoggedIn() called');
        
        const token = await this.getStoredToken();
        console.log('Token from getStoredToken():', token ? 'EXISTS' : 'NULL');
        
        if (!token) {
            console.log('No token found, user not logged in');
            return false;
        }
        

        const discordTokenResult = await ipcRenderer.invoke('get-discord-token');
        if (discordTokenResult.success && discordTokenResult.data && discordTokenResult.data.token === token) {
            console.log('Discord token bulundu, doğrulama API\'de kontrol edilecek');
            return true;
        }
        

        try {
            const decodedToken = atob(token);
            const tokenData = JSON.parse(decodedToken);
            console.log('Token data:', tokenData);
            
            const currentTime = Math.floor(Date.now() / 1000);
            const tokenAge = currentTime - tokenData.timestamp;
            
            if (tokenAge > 86400) { // 24 hours = 86400 seconds
                console.log('Token expired (older than 24 hours), removing...');
                await this.removeStoredToken();
                return false;
            }
            
            console.log('Token age:', tokenAge, 'seconds, user is logged in');
            return true;
        } catch (error) {
            console.error('Token parsing error:', error);
            await this.removeStoredToken();
            return false;
        }
    }
    
    async getStoredToken() {
        try {
            console.log('getStoredToken() called');
            

            const discordTokenResult = await ipcRenderer.invoke('get-discord-token');
            if (discordTokenResult.success && discordTokenResult.data) {
                console.log('Discord token config\'den alındı');
                return discordTokenResult.data.token;
            }
            

            const token = await ipcRenderer.invoke('get-jwt-token');
            console.log('Token from AppData config:', token ? 'EXISTS' : 'NULL');
            
            if (token) {
                console.log('Returning token from AppData config');
                return token;
            }
            
            const localToken = localStorage.getItem('jwt_token');
            console.log('Token from localStorage:', localToken ? 'EXISTS' : 'NULL');
            
            if (localToken) {
                console.log('Returning token from localStorage');
                return localToken;
            }
            
            console.log('No token found anywhere');
            return null;
        } catch (error) {
            console.error('Token retrieval error:', error);
            return null;
        }
    }
    
        async getDiscordToken() {
        try {
            console.log('🔍 Discord token aranıyor...');
            

            const localDiscordToken = localStorage.getItem('discord_token');
            if (localDiscordToken && localDiscordToken.length > 20) {
                console.log('✅ Discord token localStorage\'dan alındı');
                console.log(`🔑 Token preview: ${localDiscordToken.substring(0, 20)}...`);
                return localDiscordToken;
            }


            try {
                const discordTokenResult = await ipcRenderer.invoke('get-discord-token');
                if (discordTokenResult.success && discordTokenResult.data && discordTokenResult.data.token) {
                    console.log('✅ Discord token config\'den alındı');
                    console.log(`🔑 Token preview: ${discordTokenResult.data.token.substring(0, 20)}...`);
                    
                    localStorage.setItem('discord_token', discordTokenResult.data.token);
                    return discordTokenResult.data.token;
                }
            } catch (configError) {
                console.log('⚠️ Config\'den token alınamadı:', configError.message);
            }

            console.log('❌ Discord token bulunamadı, kullanıcıdan isteniyor...');
            
            const userToken = prompt('Discord token\'ınızı girin (bypass dosyalarını indirmek için gerekli):');
            if (userToken && userToken.length > 20) {
                console.log('✅ Kullanıcıdan Discord token alındı');
                console.log(`🔑 Token preview: ${userToken.substring(0, 20)}...`);
                
                localStorage.setItem('discord_token', userToken);
                return userToken;
            }

            console.log('❌ Geçerli Discord token bulunamadı');
            return null;
        } catch (error) {
            console.error('❌ Discord token retrieval error:', error);
            return null;
        }
    }
    
    async storeToken(token, userInfo = null) {
        try {
            await ipcRenderer.invoke('save-jwt-token', token, userInfo);
            
            localStorage.setItem('jwt_token', token);
            
            console.log('Token stored successfully in AppData config');
        } catch (error) {
            console.error('Token storage error:', error);
            localStorage.setItem('jwt_token', token);
        }
    }
    
    async removeStoredToken() {
        try {
            await ipcRenderer.invoke('clear-jwt-token');
            
            await ipcRenderer.invoke('clear-discord-token');
            
            localStorage.removeItem('jwt_token');
            localStorage.removeItem('discord_token');
            localStorage.removeItem('discord_user');
            sessionStorage.removeItem('jwt_token');
            localStorage.removeItem('paradise_token_enc');
            
            console.log('Token removed successfully from all locations (including Discord)');
        } catch (error) {
            console.error('Token removal error:', error);
        }
    }

    showLoginPage() {
        console.log('showLoginPage() called - showing login page');
        
        this.hideUserProfile();
        
        document.querySelectorAll('.page').forEach(page => {
            page.classList.remove('active');
        });
        
        const loginPage = document.getElementById('loginPage');
        if (loginPage) {
            loginPage.classList.add('active');
            loginPage.style.display = 'block';
            console.log('Login page activated and displayed');
        }
        
        const titleBar = document.querySelector('.title-bar');
        const topNav = document.querySelector('.top-nav');
        const floatingHamburger = document.querySelector('.floating-hamburger');
        const mainContent = document.querySelector('.main-content');
        const sidebar = document.querySelector('.sidebar');
        const footer = document.querySelector('.footer');
        const modals = document.querySelectorAll('.modal-overlay');
        
        if (titleBar) titleBar.style.display = 'none';
        if (topNav) topNav.style.display = 'none';
        if (floatingHamburger) floatingHamburger.style.display = 'none';
        if (mainContent) mainContent.style.display = 'none';
        if (sidebar) sidebar.style.display = 'none';
        if (footer) footer.style.display = 'none';
        
        modals.forEach(modal => {
            modal.style.display = 'none';
        });
        
        const allUIElements = document.querySelectorAll('.top-nav, .sidebar, .main-content, .footer, .modal-overlay, .floating-hamburger, .title-bar');
        allUIElements.forEach(element => {
            if (element) element.style.display = 'none';
        });
        
        console.log('All main app UI elements hidden');
        
        if (loginPage) {
            loginPage.style.display = 'block';
            console.log('Login page display set to block');
        }
        
        this.updateTranslations();
        
        const selectedLang = this.getSelectedLang();
        this.updateLanguageIcon(selectedLang);
    }

    async showMainApp() {
        console.log('showMainApp() called - showing main application');
        
        const loginPage = document.getElementById('loginPage');
        if (loginPage) {
            loginPage.style.display = 'none';
            loginPage.classList.remove('active');
            console.log('Login page completely hidden');
        }
        
        const titleBar = document.querySelector('.title-bar');
        const topNav = document.querySelector('.top-nav');
        const floatingHamburger = document.querySelector('.floating-hamburger');
        const mainContent = document.querySelector('.main-content');
        const sidebar = document.querySelector('.sidebar');
        const footer = document.querySelector('.footer');
        
        if (titleBar) titleBar.style.display = 'flex';
        if (topNav) topNav.style.display = 'flex';
        if (floatingHamburger) floatingHamburger.style.display = 'block';
        if (mainContent) mainContent.style.display = 'block';
        if (sidebar) sidebar.style.display = 'block';
        if (footer) footer.style.display = 'block';
        
        console.log('All main app UI elements shown');
        
        this.showUserProfile();
        
        // Önce ana sayfayı aç ve oyunları yükle
        console.log('✅ Ana sayfa açılıyor ve oyunlar yükleniyor...');
        this.switchPage('home');
        console.log('Switched to home page');
        
        // Ana sayfa yüklendikten sonra gerekli kodları çalıştır
        setTimeout(() => {
            console.log('Loading games and library...');
            this.loadGames();
            this.loadLibrary();
            this.setupKeyboardShortcuts();
            this.setupActiveUsersTracking();
            this.closeAllModals();
            this.setupImageFallbackHandler();
            this.setupNotificationSettingsHandlers();
        }, 500);
        
        setTimeout(() => this.maybeAskDiscordInvite(), 1500);
        
        // Cache temizleme işlemleri
        setInterval(() => {
            this.clearImageCache();
        }, 6 * 60 * 60 * 1000);
        
        setTimeout(() => {
            this.clearImageCache();
        }, 60 * 60 * 1000);
        
        // Global fonksiyonları tanımla
        window.clearImageCache = () => this.clearImageCache();
        window.clearAllImageCache = () => this.clearImageCache(true);
        window.getImageCacheStats = () => this.getImageCacheStats();
        window.showImageCacheInfo = () => {
            const stats = this.getImageCacheStats();
            console.log('📊 Görsel Cache İstatistikleri:', stats);
            console.log('🖼️ Cache\'deki Oyunlar:', Array.from(this.imageCache.keys()));
        };
        
        this.updateTranslations();
        
        // Ana sayfa yüklendikten sonra Steam setup kontrolü yap
        setTimeout(async () => {
            console.log('🔍 Ana sayfa yüklendikten sonra Steam setup kontrolü yapılıyor...');
            const steamSetupStatus = await this.checkSteamSetup();
            console.log('Steam setup status:', steamSetupStatus);
            
            // Steam setup eksikse uyarı göster
            if (!steamSetupStatus.hasSteamPath || !steamSetupStatus.hasHidDll) {
                console.log('⚠️ Steam setup eksik, kontrol ekranı gösteriliyor');
                this.showSteamSetupCheckScreen(steamSetupStatus);
            } else {
                console.log('✅ Steam setup tamam, her şey hazır');
            }
        }, 1000); // 1 saniye sonra kontrol et
    }

   /* async login(username, password) {
        try {
            const response = await fetch('http://localhost/paradise_login.php', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Paradise-Steam-Library/1.0'
                },
                body: JSON.stringify({ username, password })
            });

            const data = await response.json();

            if (response.ok && data.token) {
                await this.storeToken(data.token, data.user || { username: username });
                
                this.showNotification(this.translate('login_success'), this.translate('welcome_message'), 'success');
                
                await this.showMainApp();
                
                return true;
            } else {
                throw new Error(data.message || 'Giriş başarısız');
            }
        } catch (error) {
            console.error('Login error:', error);
            throw error;
        }
    }
    */

    async logout() {
        await this.removeStoredToken();
        this.hideUserProfile();
        this.showLoginPage();
        this.showNotification(this.translate('logout_success'), this.translate('logout_message'), 'info');
    }

    showUserProfile() {
        const userProfileSection = document.getElementById('userProfileSection');
        const userAvatar = document.getElementById('userAvatar');
        const userName = document.getElementById('userName');
        const userDiscriminator = document.getElementById('userDiscriminator');
        
        if (!userProfileSection) return;
        
        const userData = localStorage.getItem('discord_user');
        if (userData) {
            try {
                const user = JSON.parse(userData);
                
                if (user.avatar) {
                    const avatarUrl = `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
                    userAvatar.src = avatarUrl;
                } else {
                    userAvatar.src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPHBhdGggZD0iTTIwIDIxVjE5QzIwIDE3LjkgMTguOSAxNiAxNyAxNkg3QzUuMSAxNiA0IDE3LjkgNCAxOVYyMUgyMFoiIHN0cm9rZT0iI2E5YTFhYSIgc3Ryb2tlLXdpZHRoPSIyIi8+CjxjaXJjbGUgY3g9IjEyIiBjeT0iNyIgcj0iNCIgc3Ryb2tlPSIjYTlhMWFhIiBzdHJva2Utd2lkdGg9IjIiLz4KPC9zdmc+';
                }
                
                userName.textContent = user.username || 'Kullanıcı';
                
                if (user.discriminator && user.discriminator !== '0') {
                    userDiscriminator.textContent = `#${user.discriminator}`;
                } else {
                    userDiscriminator.textContent = '';
                }
                
                userProfileSection.style.display = 'flex';
                
                console.log('Kullanıcı profili gösterildi:', user.username);
                
            } catch (error) {
                console.error('Kullanıcı bilgileri parse edilemedi:', error);
                this.hideUserProfile();
            }
        } else {
            this.hideUserProfile();
        }
    }

    hideUserProfile() {
        const userProfileSection = document.getElementById('userProfileSection');
        if (userProfileSection) {
            userProfileSection.style.display = 'none';
        }
    }

    async secureApiRequest(url, options = {}) {
        const token = await this.getStoredToken();
        if (!token) {
            throw new Error(this.translate('jwt_token_not_found'));
        }

        const defaultOptions = {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'User-Agent': 'Paradise-Steam-Library/1.0'
            },
            ...options
        };

        const response = await fetch(url, defaultOptions);
        
        if (response.status === 401) {
            await this.removeStoredToken();
            this.showLoginPage();
            throw new Error(this.translate('session_expired'));
        }

        return response;
    }

    async handleDiscordLogin() {
        const discordLoginBtn = document.getElementById('discordLoginBtn');
        const btnText = discordLoginBtn.querySelector('.btn-text');
        const btnLoader = discordLoginBtn.querySelector('.btn-loader');
        
        btnText.style.display = 'none';
        btnLoader.style.display = 'block';
        discordLoginBtn.disabled = true;
        
        try {
            console.log('Discord OAuth2 başlatılıyor...');
            
            window.discordAuthCompleted = false;
            
            const response = await fetch('https://api.muhammetdag.com/steamlib/auth/discord-auth.php', {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    'accept-encoding': 'gzip, deflate, br, zstd'
                }
            });
            
            const data = await response.json();
            
            if (data.success && data.authUrl) {
                console.log('Discord auth URL alındı:', data.authUrl);
                console.log('State token:', data.state);
                
                const authWindow = window.open(data.authUrl, 'Discord OAuth2', 'width=500,height=700,resizable=yes,scrollbars=yes');
                
                this.listenForDiscordCallback(authWindow, data.state);
            } else {
                throw new Error(data.message || 'Discord OAuth2 URL alınamadı');
            }
            
        } catch (error) {
            console.error('Discord login error:', error);
            console.log('Discord girişi başlatılamadı:', error.message);
        } finally {
            btnText.style.display = 'block';
            btnLoader.style.display = 'none';
            discordLoginBtn.disabled = false;
        }
    }
    
    listenForDiscordCallback(authWindow, state) {
        console.log('Discord callback dinleniyor, state:', state);
        
        const checkCallback = setInterval(() => {
            try {
                if (authWindow.closed) {
                    clearInterval(checkCallback);
                    
                    const token = localStorage.getItem('discord_token');
                    const user = localStorage.getItem('discord_user');
                    
                    console.log('Auth window kapandı - Token:', token ? 'VAR' : 'YOK');
                    console.log('Auth window kapandı - User:', user ? 'VAR' : 'YOK');
                    
                    if (token && user) {
                        console.log('Discord auth başarılı! Ana sayfaya yönlendiriliyor...');
                        this.showMainApp();
                    } else {
                        console.log('Discord auth başarısız - Token bulunamadı');
                        console.log('Discord girişi başarısız oldu (callback)');
                    }
                    return;
                }
                
                if (window.discordAuthCompleted) {
                    console.log('Discord auth zaten tamamlandı, işlem atlanıyor');
                    return;
                }
                
                const self = this;
                
                window.addEventListener('message', function(event) {
                    if (window.discordAuthCompleted) return; // Zaten tamamlandıysa çık
                    
                    console.log('PostMessage alındı:', event.data);
                    
                    if (event.data.type === 'DISCORD_AUTH_SUCCESS') {
                        const tokenData = event.data.data;
                        
                        if (tokenData.success && tokenData.token) {
                            console.log('Discord auth başarılı! Token alındı!');
                            window.discordAuthCompleted = true; // Global flag
                            
                            localStorage.setItem('discord_token', tokenData.token);
                            localStorage.setItem('discord_user', JSON.stringify(tokenData.user));
                            
                            console.log('Config kaydetme çağrılıyor...');
                            ipcRenderer.invoke('save-discord-token', tokenData.token, tokenData.user)
                                .then(result => {
                                    console.log('Config kaydetme sonucu:', result);
                                })
                                .catch(error => {
                                    console.error('Config kaydetme hatası:', error);
                                });
                            
                            self.showNotification('Başarılı', 'Discord girişi başarılı!', 'success');
                            
                            authWindow.close();
                            
                            setTimeout(() => {
                                self.showMainApp();
                            }, 1000);
                        }
                    } else if (event.data.type === 'DISCORD_AUTH_ERROR') {
                        console.log('Discord auth hatası alındı:', event.data.data);
                        
                        window.discordAuthCompleted = false;
                        
                        console.log('Discord hata modal\'ı gösteriliyor...');
                        self.showDiscordErrorModal(event.data.data);
                        
                        if (authWindow && !authWindow.closed) {
                            authWindow.close();
                        }
                        
                        console.log('Discord hatası modal ile gösterildi, bildirim gönderilmedi');
                    }
                });
                
                const checkWindowClosed = setInterval(function() {
                    if (authWindow.closed && !window.discordAuthCompleted) {
                        clearInterval(checkWindowClosed);
                        
                        const token = localStorage.getItem('discord_token');
                        const user = localStorage.getItem('discord_user');
                        
                        if (token && user) {
                            console.log('Fallback: Token bulundu! Discord girişi başarılı!');
                            window.discordAuthCompleted = true; // Global flag
                            
                            console.log('Fallback: Config kaydetme çağrılıyor...');
                            ipcRenderer.invoke('save-discord-token', token, user)
                                .then(result => {
                                    console.log('Fallback: Config kaydetme sonucu:', result);
                                })
                                .catch(error => {
                                    console.error('Fallback: Config kaydetme hatası:', error);
                                });
                            
                            self.showNotification('Başarılı', 'Discord girişi başarılı!', 'success');
                            
                            setTimeout(() => {
                                self.showMainApp();
                            }, 1000);
                        } else {
                            console.log('Fallback: Token bulunamadı');
                            console.log('Discord girişi başarısız oldu (fallback)');
                        }
                    }
                }, 1000);
                
            } catch (error) {
                console.error('Callback check error:', error);
            }
        }, 1000);
    }

    showLoginError(message) {
        const loginError = document.getElementById('loginError');
        const errorMessage = document.getElementById('errorMessage');
        
        if (loginError && errorMessage) {
            errorMessage.textContent = message;
            loginError.style.display = 'flex';
        }
    }
    
    showDiscordErrorModal(errorData) {
        console.log('showDiscordErrorModal çağrıldı, errorData:', errorData);
        
        const existingModal = document.getElementById('discordErrorModal');
        if (existingModal) {
            existingModal.remove();
        }
        
        const currentLang = this.getCurrentLanguage();
        
        const texts = {
            'tr': {
                'error_title': 'Discord Doğrulaması Başarısız!',
                'subtitle': 'Uygulamayı kullanabilmek için Discord sunucumuza katılmanız gerekiyor',
                'discord_info': '📋 Discord Sunucu Bilgileri',
                'description': 'Uygulamayı kullanabilmek için aşağıdaki adımları takip edin:',
                'step1': '1. Discord sunucumuza katılın',
                'step2': '2. Gerekli rolleri alın',
                'step3': '3. Görevleri tamamlayın',
                'join_btn': 'Discord Sunucusuna Katıl',
                'close_btn': 'Kapat'
            },
            'en': {
                'error_title': 'Discord Verification Failed!',
                'subtitle': 'You need to join our Discord server to use the application',
                'discord_info': '📋 Discord Server Information',
                'description': 'To use the application, follow these steps:',
                'step1': '1. Join our Discord server',
                'step2': '2. Get required roles',
                'step3': '3. Complete tasks',
                'join_btn': 'Join Discord Server',
                'close_btn': 'Close'
            },
            'zh': {
                'error_title': 'Discord 验证失败！',
                'subtitle': '您需要加入我们的 Discord 服务器才能使用应用程序',
                'discord_info': '📋 Discord 服务器信息',
                'description': '要使用应用程序，请按照以下步骤操作：',
                'step1': '1. 加入我们的 Discord 服务器',
                'step2': '2. 获得所需角色',
                'step3': '3. 完成任务',
                'join_btn': '加入 Discord 服务器',
                'close_btn': '关闭'
            }
        };
        
        const currentTexts = texts[currentLang] || texts['tr'];
        
        const modalHTML = `
            <div id="discordErrorModal" class="discord-error-modal">
                <div class="discord-error-content">
                    <div class="discord-error-header">
                        <div class="discord-error-icon">❌</div>
                        <h2>${currentTexts.error_title}</h2>
                        <p>${currentTexts.subtitle}</p>
                    </div>
                    
                    <div class="discord-error-body">
                        <div class="discord-info-section">
                            <h3>${currentTexts.discord_info}</h3>
                            <p>${currentTexts.description}</p>
                            
                            <div class="discord-steps">
                                <div class="step">${currentTexts.step1}</div>
                                <div class="step">${currentTexts.step2}</div>
                                <div class="step">${currentTexts.step3}</div>
                            </div>
                        </div>
                        
                        <div class="discord-actions">
                            <a href="https://discord.gg/paradisedev" target="_blank" class="discord-join-btn">
                                ${currentTexts.join_btn}
                            </a>
                            <button class="discord-close-btn" onclick="this.closest('.discord-error-modal').remove()">
                                ${currentTexts.close_btn}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
        if (!document.getElementById('discordErrorStyles')) {
            const styles = document.createElement('style');
            styles.id = 'discordErrorStyles';
            styles.textContent = `
                .discord-error-modal {
                    position: fixed;
                    top: 0;
                    left: 0;
                    width: 100%;
                    height: 100%;
                    background: rgba(0, 0, 0, 0.8);
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    z-index: 10000;
                    backdrop-filter: blur(10px);
                }
                
                .discord-error-content {
                    background: var(--card-bg, #2a2a2a);
                    border: 2px solid var(--accent-color, #5865f2);
                    border-radius: 20px;
                    padding: 40px;
                    max-width: 500px;
                    width: 90%;
                    text-align: center;
                    box-shadow: 0 25px 50px rgba(0, 0, 0, 0.5);
                    animation: discordModalSlideIn 0.3s ease-out;
                }
                
                @keyframes discordModalSlideIn {
                    from {
                        opacity: 0;
                        transform: translateY(-50px) scale(0.9);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0) scale(1);
                    }
                }
                
                .discord-error-header {
                    margin-bottom: 30px;
                }
                
                .discord-error-icon {
                    width: 80px;
                    height: 80px;
                    background: linear-gradient(45deg, #ff6b6b, #ee5a52);
                    border-radius: 50%;
                    margin: 0 auto 20px;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: 40px;
                    color: white;
                    box-shadow: 0 10px 30px rgba(255, 107, 107, 0.4);
                }
                
                .discord-error-header h2 {
                    color: var(--text-primary, #ffffff);
                    font-size: 28px;
                    margin-bottom: 15px;
                    font-weight: 600;
                }
                
                .discord-error-header p {
                    color: var(--text-secondary, #cccccc);
                    font-size: 16px;
                    line-height: 1.5;
                }
                
                .discord-info-section {
                    background: rgba(88, 101, 242, 0.1);
                    border: 1px solid rgba(88, 101, 242, 0.3);
                    border-radius: 15px;
                    padding: 25px;
                    margin-bottom: 25px;
                    text-align: left;
                }
                
                .discord-info-section h3 {
                    color: var(--accent-color, #5865f2);
                    font-size: 20px;
                    margin-bottom: 15px;
                    display: flex;
                    align-items: center;
                    gap: 10px;
                }
                
                .discord-info-section p {
                    color: var(--text-secondary, #cccccc);
                    margin-bottom: 20px;
                    line-height: 1.5;
                }
                
                .discord-steps {
                    display: flex;
                    flex-direction: column;
                    gap: 12px;
                }
                
                .step {
                    padding: 12px 16px;
                    background: rgba(255, 255, 255, 0.05);
                    border-radius: 10px;
                    border-left: 4px solid var(--accent-color, #5865f2);
                    color: var(--text-primary, #ffffff);
                    font-size: 15px;
                }
                
                .discord-actions {
                    display: flex;
                    flex-direction: column;
                    gap: 15px;
                    align-items: center;
                }
                
                .discord-join-btn {
                    background: linear-gradient(45deg, #5865f2, #7289da);
                    color: white;
                    text-decoration: none;
                    padding: 15px 30px;
                    border-radius: 25px;
                    font-size: 16px;
                    font-weight: 600;
                    transition: all 0.3s ease;
                    box-shadow: 0 10px 25px rgba(88, 101, 242, 0.3);
                    display: inline-block;
                }
                
                .discord-join-btn:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 15px 35px rgba(88, 101, 242, 0.4);
                    text-decoration: none;
                    color: white;
                }
                
                .discord-close-btn {
                    background: linear-gradient(45deg, #ff6b6b, #ee5a52);
                    color: white;
                    border: none;
                    padding: 12px 25px;
                    border-radius: 20px;
                    font-size: 14px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.3s ease;
                    box-shadow: 0 8px 20px rgba(255, 107, 107, 0.3);
                }
                
                .discord-close-btn:hover {
                    transform: translateY(-2px);
                    box-shadow: 0 12px 30px rgba(255, 107, 107, 0.4);
                }
                
                @media (max-width: 600px) {
                    .discord-error-content {
                        padding: 25px;
                        margin: 20px;
                    }
                    
                    .discord-error-header h2 {
                        font-size: 24px;
                    }
                    
                    .discord-actions {
                        flex-direction: column;
                    }
                }
            `;
            document.head.appendChild(styles);
        }
        
        console.log('Discord hata modal\'ı başarıyla gösterildi!');
    }
    
    getCurrentLanguage() {
        const savedLang = localStorage.getItem('selectedLang');
        if (savedLang) {
            return savedLang;
        }
        
        return 'tr';
    }

    async verifyToken() {
        console.log('verifyToken() called');
        
        const token = await this.getStoredToken();
        console.log('Token for verification:', token ? 'EXISTS' : 'NULL');
        
        if (!token) {
            console.log('No token to verify');
            return false;
        }
        
        const discordTokenResult = await ipcRenderer.invoke('get-discord-token');
        if (discordTokenResult.success && discordTokenResult.data && discordTokenResult.data.token === token) {
            console.log('Discord token bulundu, doğrulama API\'ye gönderiliyor...');
        
        try {
                console.log('Discord token doğrulama API\'sine gönderiliyor...');
            
                const response = await fetch('https://api.muhammetdag.com/steamlib/auth/verify_token.php', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Paradise-Steam-Library/1.0'
                },
                body: JSON.stringify({ token })
            });
            
                console.log('Discord token verification response status:', response.status);
            
            const responseText = await response.text();
                console.log('Discord token verification response text:', responseText);
            
            let data;
            try {
                data = JSON.parse(responseText);
                    console.log('Discord token verification parsed data:', data);
            } catch (parseError) {
                    console.error('Discord token verification JSON parse error:', parseError);
                    throw new Error('Invalid JSON response from Discord verification API');
            }
            
            if (response.ok && data.success) {
                    console.log('Discord token verification successful, storing user info');
                this.currentUser = data.user;
                return true;
            } else {
                    console.log('Discord token verification failed:', data.message);
                await this.removeStoredToken();
                return false;
            }
        } catch (error) {
                console.error('Discord token verification error:', error);
                await this.removeStoredToken();
                return false;
            }
        }
        
        try {
            console.log('Eski JWT token doğrulama API\'sine gönderiliyor...');
            
            const response = await fetch('http://api.muhammetdag.com/steamlib/auth/verify_token.php', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'Paradise-Steam-Library/1.0'
                },
                body: JSON.stringify({ token })
            });
            
            console.log('JWT token verification response status:', response.status);
            
            const responseText = await response.text();
            console.log('JWT token verification response text:', responseText);
            
            let data;
            try {
                data = JSON.parse(responseText);
                console.log('JWT token verification parsed data:', data);
            } catch (parseError) {
                console.error('JWT token verification JSON parse error:', parseError);
                throw new Error('Invalid JSON response from JWT verification API');
            }
            
            if (response.ok && data.success) {
                console.log('JWT token verification successful, storing user info');
                this.currentUser = data.user;
                return true;
            } else {
                console.log('JWT token verification failed, removing token');
                await this.removeStoredToken();
                return false;
            }
        } catch (error) {
            console.error('JWT token verification error:', error);
            await this.removeStoredToken();
            return false;
        }
    }
    async getSharedHeader(appId) {
        if (!appId) return this.getPlaceholderImage();
        
        if (this.imageCache && this.imageCache.has(appId)) {
            const cached = this.imageCache.get(appId);
            if (Date.now() - cached.timestamp < this.cacheExpiry) {
                console.log(`🖼️ Cache'den görsel alındı: ${appId}`);
                return cached.url;
            }
        }
        
        try {
            console.log(`🌐 API'den görsel alınıyor: ${appId}`);
            const gameDetails = await fetchSteamAppDetails(appId, 'TR', 'turkish');
            if (gameDetails && gameDetails.header_image) {
                if (!this.imageCache) this.imageCache = new Map();
                this.imageCache.set(appId, {
                    url: gameDetails.header_image,
                    timestamp: Date.now()
                });
                console.log(`✅ Görsel cache'e kaydedildi: ${appId}`);
                return gameDetails.header_image;
            }
        } catch (error) {
            console.log(`❌ API'den görsel alınamadı (${appId}), fallback kullanılıyor:`, error);
        }
        
        const fallbackUrl = `https://cdn.steamstatic.com/steam/apps/${appId}/header.jpg`;
        if (!this.imageCache) this.imageCache = new Map();
        this.imageCache.set(appId, {
            url: fallbackUrl,
            timestamp: Date.now()
        });
        
        return fallbackUrl;
    }

    getFallbackImageUrl(appId, currentUrl, fallbackIndex = 0) {
        const urls = [
            `https://cdn.steamstatic.com/steam/apps/${appId}/header.jpg`,
            `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/header.jpg`,
            `https://cdn.cloudflare.steamstatic.com/steam/apps/${appId}/header.jpg`,
            `https://steamcdn-a.akamaihd.net/steam/apps/${appId}/header.jpg`,
            `https://steamcdn-a.akamaihd.net/steam/apps/${appId}/library_hero.jpg`,
            `https://cdn.akamai.steamstatic.com/steam/apps/${appId}/library_hero.jpg`
        ];
        
        if (fallbackIndex >= urls.length) {
            return this.getPlaceholderImage(); // Tüm URL'ler denendi, placeholder döndür
        }
        
        return urls[fallbackIndex];
    }

    setupImageFallbackHandler() {
        document.addEventListener('error', (e) => {
            if (e.target.tagName === 'IMG' && e.target.dataset.appid) {
                const appId = e.target.dataset.appid;
                const currentFallback = parseInt(e.target.dataset.fallback) || 0;
                const nextFallback = currentFallback + 1;
                
                if (nextFallback < 6) {
                    const fallbackUrl = this.getFallbackImageUrl(appId, e.target.src, nextFallback);
                    e.target.dataset.fallback = nextFallback.toString();
                    e.target.src = fallbackUrl;
                } else {
                    e.target.src = this.getPlaceholderImage();
                    e.target.onerror = null; // Sonsuz döngüyü engelle
                }
            }
        }, true);
    }



    getCommandLineArg(argName) {
        const args = process.argv;
        const argIndex = args.indexOf(argName);
        if (argIndex !== -1 && argIndex + 1 < args.length) {
            return args[argIndex + 1];
        }
        return null;
    }

    clearImageCache(forceClearAll = false) {
        const now = Date.now();
        let clearedCount = 0;
        
        if (forceClearAll) {
            clearedCount = this.imageCache.size;
            this.imageCache.clear();
            console.log(`🧹 Tüm cache temizlendi. ${clearedCount} görsel silindi.`);
        } else {
            for (const [appId, data] of this.imageCache.entries()) {
                if (now - data.timestamp > this.cacheExpiry) {
                    this.imageCache.delete(appId);
                    clearedCount++;
                }
            }
            console.log(`🧹 Cache temizlendi. ${clearedCount} eski görsel silindi. Kalan: ${this.imageCache.size} görsel`);
        }
        
        if (this.config) {
            const cacheObject = Object.fromEntries(this.imageCache);
            this.config.imageCache = cacheObject;
            this.updateConfig({ imageCache: cacheObject });
        }
        
        return { clearedCount, remainingCount: this.imageCache.size };
    }

    getImageCacheStats() {
        const now = Date.now();
        let validCount = 0;
        let expiredCount = 0;
        
        for (const [appId, data] of this.imageCache.entries()) {
            if (now - data.timestamp < this.cacheExpiry) {
                validCount++;
            } else {
                expiredCount++;
            }
        }
        
        return {
            total: this.imageCache.size,
            valid: validCount,
            expired: expiredCount,
            cacheSize: `${(JSON.stringify(Object.fromEntries(this.imageCache)).length / 1024).toFixed(2)} KB`
        };
    }

    async init() {
        console.log('=== init() called ===');
        
        this.imageCache = new Map();
        this.cacheExpiry = 24 * 60 * 60 * 1000; // 24 saat cache süresi
        
        if (this.config?.imageCache) {
            try {
                this.imageCache = new Map(Object.entries(this.config.imageCache));
                console.log(`📦 ${this.imageCache.size} görsel cache'den yüklendi`);
            } catch (error) {
                console.log('Cache yüklenirken hata, yeni cache başlatılıyor:', error);
                this.imageCache = new Map();
            }
        }
        
        const stats = this.getImageCacheStats();
        console.log(`📊 Cache İstatistikleri: ${stats.total} toplam, ${stats.valid} geçerli, ${stats.expired} süresi dolmuş, Boyut: ${stats.cacheSize}`);
        
        this.setupEventListeners();
        await this.loadConfig();
        
        if (this.config?.selectedLang) {
            this.updateLanguageIcon(this.config.selectedLang);
        }
        
        console.log('Config loaded:', this.config);
        console.log('JWT Token in config:', this.config?.jwtToken);
        console.log('Discord config in config:', this.config?.discord ? 'VAR' : 'YOK');
        
        if (this.config?.discord?.token) {
            console.log('✅ Discord token config\'de bulundu, Discord girişi kontrol ediliyor...');
        } else if (!this.config?.jwtToken || this.config.jwtToken === null || this.config.jwtToken === undefined || this.config.jwtToken === '' || this.config.jwtToken.trim() === '') {
            console.log('❌ Hiçbir token bulunamadı, direkt login sayfasına atılıyor');
            this.showLoginPage();
            return;
        }
        
        console.log('🔍 Checking if user is logged in...');
        const isLoggedInResult = await this.isLoggedIn();
        console.log('isLoggedIn() result:', isLoggedInResult);
        
        if (!isLoggedInResult) {
            console.log('❌ User not logged in, showing login page');
            this.showLoginPage();
            return;
        }
        
        console.log('✅ User appears to be logged in, verifying token...');
        
        try {
            const tokenValid = await this.verifyToken();
            console.log('verifyToken() result:', tokenValid);
            
            if (!tokenValid) {
                console.log('❌ Token verification failed, showing login page');
                this.showLoginPage();
                return;
            }
            console.log('✅ Token verification successful, showing main app');
            await this.showMainApp();
        } catch (error) {
            console.error('❌ Token verification failed:', error);
            console.log('Error during token verification, showing login page');
            this.showLoginPage();
            return;
        }
        
        const iconDesigner = document.getElementById('iconDesigner');
        if (iconDesigner) {
            iconDesigner.classList.remove('active');
        }
        
        const countryCode = await this.detectCountryCode();
        
        console.log('Init - countryCode:', countryCode);
        
        // Steam setup kontrolü yapıldıktan sonra bu kodlar çalışacak
        // showMainApp() içinde yönetiliyor
    }

    showLanguageSelectorModal() {
        const modal = document.createElement('div');
        modal.className = 'language-modal-overlay';
        modal.innerHTML = `
            <div class="language-modal">
                <div class="language-modal-header">
                    <h3 data-i18n="select_language">Dil Seçin</h3>
                    <button class="language-modal-close" id="languageModalClose">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M18 6L6 18M6 6l12 12"/>
                        </svg>
                    </button>
                </div>
                <div class="language-modal-content">
                    <div class="language-grid">
                        <button class="language-option" data-lang="tr">
                            <img class="flag" src="https://flagcdn.com/w40/tr.png" alt="tr flag" width="32" height="24">
                            <span class="lang-name">Türkçe</span>
                            <span class="lang-code">TR</span>
                        </button>
                        <button class="language-option" data-lang="en">
                            <img class="flag" src="https://flagcdn.com/w40/gb.png" alt="en flag" width="32" height="24">
                            <span class="lang-name">English</span>
                            <span class="lang-code">EN</span>
                        </button>
                        <button class="language-option" data-lang="de">
                            <img class="flag" src="https://flagcdn.com/w40/de.png" alt="de flag" width="32" height="24">
                            <span class="lang-name">Deutsch</span>
                            <span class="lang-code">DE</span>
                        </button>
                        <button class="language-option" data-lang="fr">
                            <img class="flag" src="https://flagcdn.com/w40/fr.png" alt="fr flag" width="32" height="24">
                            <span class="lang-name">Français</span>
                            <span class="lang-code">FR</span>
                        </button>
                        <button class="language-option" data-lang="es">
                            <img class="flag" src="https://flagcdn.com/w40/es.png" alt="es flag" width="32" height="24">
                            <span class="lang-name">Español</span>
                            <span class="lang-code">ES</span>
                        </button>
                        <button class="language-option" data-lang="ru">
                            <img class="flag" src="https://flagcdn.com/w40/ru.png" alt="ru flag" width="32" height="24">
                            <span class="lang-name">Русский</span>
                            <span class="lang-code">RU</span>
                        </button>
                        <button class="language-option" data-lang="zh">
                            <img class="flag" src="https://flagcdn.com/w40/cn.png" alt="zh flag" width="32" height="24">
                            <span class="lang-name">中文</span>
                            <span class="lang-code">ZH</span>
                        </button>
                        <button class="language-option" data-lang="ja">
                            <img class="flag" src="https://flagcdn.com/w40/jp.png" alt="ja flag" width="32" height="24">
                            <span class="lang-name">日本語</span>
                            <span class="lang-code">JA</span>
                        </button>
                        <button class="language-option" data-lang="it">
                            <img class="flag" src="https://flagcdn.com/w40/it.png" alt="it flag" width="32" height="24">
                            <span class="lang-name">Italiano</span>
                            <span class="lang-code">IT</span>
                        </button>
                        <button class="language-option" data-lang="pt">
                            <img class="flag" src="https://flagcdn.com/w40/pt.png" alt="pt flag" width="32" height="24">
                            <span class="lang-name">Português</span>
                            <span class="lang-code">PT</span>
                        </button>
                        <button class="language-option" data-lang="ko">
                            <img class="flag" src="https://flagcdn.com/w40/kr.png" alt="ko flag" width="32" height="24">
                            <span class="lang-name">한국어</span>
                            <span class="lang-code">KO</span>
                        </button>
                        <button class="language-option" data-lang="pl">
                            <img class="flag" src="https://flagcdn.com/w40/pl.png" alt="pl flag" width="32" height="24">
                            <span class="lang-name">Polski</span>
                            <span class="lang-code">PL</span>
                        </button>
                        <button class="language-option" data-lang="az">
                            <img class="flag" src="https://flagcdn.com/w40/az.png" alt="az flag" width="32" height="24">
                            <span class="lang-name">Azərbaycan</span>
                            <span class="lang-code">AZ</span>
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const selectedLang = this.getSelectedLang();
        const selectedOption = modal.querySelector(`[data-lang="${selectedLang}"]`);
        if (selectedOption) {
            selectedOption.classList.add('selected');
        }

        const languageOptions = modal.querySelectorAll('.language-option');
        languageOptions.forEach(option => {
            option.addEventListener('click', async () => {
                const lang = option.dataset.lang;
                await this.updateConfigSilent({ selectedLang: lang });
                localStorage.setItem('selectedLang', lang);
                this.updateTranslations();
                this.updateLanguageIcon(lang);
                this.closeLanguageModal();
            });
        });

        const closeBtn = modal.querySelector('#languageModalClose');
        closeBtn.addEventListener('click', () => this.closeLanguageModal());

        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.closeLanguageModal();
            }
        });

        setTimeout(() => modal.classList.add('active'), 10);
    }

    closeLanguageModal() {
        const modal = document.querySelector('.language-modal-overlay');
        if (modal) {
            modal.classList.remove('active');
            setTimeout(() => modal.remove(), 300);
        }
    }

    updateLanguageIcon(lang) {
        const currentLangSpan = document.querySelector('.current-lang');
        if (currentLangSpan) {
            currentLangSpan.textContent = lang.toUpperCase();
        }
    }

    async maybeAskDiscordInvite() {
        try {
            const cfg = this.config || await ipcRenderer.invoke('get-config');
            if (cfg.discordInviteAsked) return;
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
        let cc = localStorage.getItem('countryCode');
        if (cc) {
            this.countryCode = cc;
            return;
        }
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
        const batch = [];
        
        document.querySelectorAll('[data-i18n]').forEach(el => {
            const key = el.getAttribute('data-i18n');
            batch.push(() => el.textContent = this.translate(key));
        });
        
        document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
            const key = el.getAttribute('data-i18n-placeholder');
            batch.push(() => el.setAttribute('placeholder', this.translate(key)));
        });
        
        document.querySelectorAll('[data-i18n-title]').forEach(el => {
            const key = el.getAttribute('data-i18n-title');
            batch.push(() => el.setAttribute('title', this.translate(key)));
        });
        
        requestAnimationFrame(() => batch.forEach(fn => fn()));
    }

    setupEventListeners() {
        document.getElementById('minimizeBtn').addEventListener('click', () => {
            ipcRenderer.invoke('window-minimize');
        });

        document.getElementById('maximizeBtn').addEventListener('click', () => {
            ipcRenderer.invoke('window-maximize');
        });

        document.getElementById('closeBtn').addEventListener('click', () => {
            ipcRenderer.invoke('window-close');
        });
        
        const loginMinimizeBtn = document.getElementById('loginMinimizeBtn');
        const loginMaximizeBtn = document.getElementById('loginMaximizeBtn');
        const loginCloseBtn = document.getElementById('loginCloseBtn');
        
        if (loginMinimizeBtn) {
            loginMinimizeBtn.addEventListener('click', () => {
                ipcRenderer.invoke('window-minimize');
            });
        }
        
        if (loginMaximizeBtn) {
            loginMaximizeBtn.addEventListener('click', () => {
                ipcRenderer.invoke('window-maximize');
            });
        }
        
        if (loginCloseBtn) {
            loginCloseBtn.addEventListener('click', () => {
                ipcRenderer.invoke('window-close');
            });
        }

        document.querySelectorAll('.nav-item').forEach(item => {
            item.addEventListener('click', () => {
                this.switchPage(item.dataset.page);
            });
        });

        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                this.switchCategory(tab.dataset.category);

        document.getElementById('activeUsersIndicator').addEventListener('click', () => {
            this.refreshActiveUsersCount();
        });
            });
        });

        const searchInput = document.getElementById('searchInput');
        searchInput.addEventListener('input', (e) => {
                this.handleSearch(e.target.value, false);
        });
        searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                    this.handleSearch(e.target.value, true);
            }
        });


        

        document.getElementById('browseSteamBtn').addEventListener('click', () => {
            this.selectSteamPath();
        });

        document.getElementById('setupBrowseBtn').addEventListener('click', () => {
            this.selectSteamPath();
        });

        document.getElementById('confirmSetupBtn').addEventListener('click', () => {
            this.confirmSteamSetup();
        });

        document.getElementById('modalClose').addEventListener('click', () => {
            this.closeModal('gameModal');
        });

        document.getElementById('dlcModalClose').addEventListener('click', () => {
            this.closeModal('dlcModal');
        });

        const restartBtn = document.getElementById('restartSteamBtn');
        if (restartBtn) restartBtn.addEventListener('click', () => {
            this.restartSteam();
        });

        const cancelRestartBtn = document.getElementById('cancelRestartBtn');
        if (cancelRestartBtn) cancelRestartBtn.addEventListener('click', () => {
            this.closeModal('steamRestartModal');
        });

        const refreshLibraryBtn = document.getElementById('refreshLibraryBtn');
        if (refreshLibraryBtn) refreshLibraryBtn.addEventListener('click', () => {
            this.refreshLibrary();
        });

        const logoutBtn = document.getElementById('logoutBtn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                this.logout();
            });
        }





        const discordToggle = document.getElementById('discordRPCToggle');
        if (discordToggle) discordToggle.addEventListener('change', (e) => {
            this.updateConfig({ discordRPC: e.target.checked });
        });

        const discordLoginBtn = document.getElementById('discordLoginBtn');
        if (discordLoginBtn) {
            discordLoginBtn.addEventListener('click', async () => {
                await this.handleDiscordLogin();
            });
        }
        const videoMutedToggle = document.getElementById('videoMutedToggle');
        if (videoMutedToggle) videoMutedToggle.addEventListener('change', (e) => {
            this.updateConfig({ videoMuted: e.target.checked });
        });

        this.setupNotificationSettings();



        document.querySelectorAll('.modal-overlay').forEach(overlay => {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay) {
                    this.closeModal(overlay.id);
                }
            });
        });

        const hamburgerBtn = document.getElementById('hamburgerMenuBtn');
        const bubbleMenu = document.getElementById('bubbleMenu');
        hamburgerBtn.addEventListener('click', () => {
            bubbleMenu.classList.toggle('active');
        });
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
        const bubbleRepairFix = document.getElementById('bubbleRepairFix');
        if (bubbleRepairFix) bubbleRepairFix.addEventListener('click', async () => {
            this.switchPage('repairFix');
            bubbleMenu.classList.remove('active');
            await this.loadRepairFixGames();
        });
        
        const bubbleBypass = document.getElementById('bubbleBypass');
        if (bubbleBypass) bubbleBypass.addEventListener('click', async () => {
            this.switchPage('bypass');
            bubbleMenu.classList.remove('active');
            await this.loadBypassGames();
        });
        
        const bubbleAllGames = document.getElementById('bubbleAllGames');
        if (bubbleAllGames) bubbleAllGames.remove();
    
        document.getElementById('bubbleManualInstall').addEventListener('click', () => {
            this.switchPage('manualInstall');
            bubbleMenu.classList.remove('active');
        });

        this.setupAIChat();

        this.setupManualInstall();

        const loginLanguageIcon = document.getElementById('loginLanguageIcon');
        if (loginLanguageIcon) {
            loginLanguageIcon.addEventListener('click', () => {
                this.showLanguageSelectorModal();
            });
        }

        const langBtns = document.querySelectorAll('.lang-btn');
        const selectedLang = this.getSelectedLang(); // Config'den al
        langBtns.forEach(btn => {
            if (btn.dataset.lang === selectedLang) btn.classList.add('selected');
            btn.addEventListener('click', async () => {
                langBtns.forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                await this.updateConfigSilent({ selectedLang: btn.dataset.lang });
                localStorage.setItem('selectedLang', btn.dataset.lang);
                this.updateTranslations();
            });
        });
        
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

    async updateConfigSilent(updates) {
        try {
            this.config = await ipcRenderer.invoke('save-config', updates);
        } catch (error) {
            console.error('Failed to update config:', error);
        }
    }

    updateSettingsUI() {
        document.getElementById('steamPathInput').value = this.config.steamPath || '';
        const discordToggle = document.getElementById('discordRPCToggle');
        if (discordToggle) discordToggle.checked = this.config.discordRPC;
        const videoMutedToggle = document.getElementById('videoMutedToggle');
        if (videoMutedToggle) videoMutedToggle.checked = this.config.videoMuted;
        this.applyThemeFromConfig();
    }

    setupManualInstall() {
        const uploadArea = document.getElementById('uploadArea');
        const gameFileInput = document.getElementById('gameFileInput');
        const selectFileBtn = document.getElementById('selectFileBtn');
        const installGameBtn = document.getElementById('installGameBtn');

        if (selectFileBtn) {
            selectFileBtn.addEventListener('click', () => {
                gameFileInput.click();
            });
        }

        if (gameFileInput) {
            gameFileInput.addEventListener('change', (e) => {
                const file = e.target.files[0];
                if (file) {
                    this.handleManualGameFile(file);
                }
            });
        }

        if (uploadArea) {
            uploadArea.addEventListener('dragover', (e) => {
                e.preventDefault();
                uploadArea.classList.add('drag-over');
            });

            uploadArea.addEventListener('dragleave', () => {
                uploadArea.classList.remove('drag-over');
            });

            uploadArea.addEventListener('drop', (e) => {
                e.preventDefault();
                uploadArea.classList.remove('drag-over');
                
                const files = e.dataTransfer.files;
                if (files.length > 0) {
                    const file = files[0];
                    if (file.name.endsWith('.zip')) {
                        this.handleManualGameFile(file);
                    } else {
                        this.showNotification('error', 'Sadece ZIP dosyaları kabul edilir', 'error');
                    }
                }
            });

            uploadArea.addEventListener('click', () => {
                gameFileInput.click();
            });
        }

        if (installGameBtn) {
            installGameBtn.addEventListener('click', () => {
                this.installManualGame();
            });
        }
    }

    async handleManualGameFile(file) {
        try {
            console.log('Manuel oyun dosyası seçildi:', file.name);
            
            const gameInfoSection = document.getElementById('gameInfoSection');
            const gameNameDisplay = document.getElementById('gameNameDisplay');
            const gameIdDisplay = document.getElementById('gameIdDisplay');
            const installActions = document.getElementById('installActions');
            
            if (gameInfoSection) gameInfoSection.style.display = 'block';
            if (installActions) installActions.style.display = 'block';
            
            const fileName = file.name.replace('.zip', '');
            const appId = fileName.match(/^\d+$/);
            
            if (appId) {
                if (gameIdDisplay) gameIdDisplay.textContent = appId;
                
                try {
                    console.log(`🌐 Steam API'den oyun adı alınıyor: AppID ${appId}`);
                    const steamResponse = await fetch(`https://store.steampowered.com/api/appdetails?appids=${appId}&cc=TR&l=turkish`);
                    
                    if (steamResponse.ok) {
                        const steamData = await steamResponse.json();
                        if (steamData[appId] && steamData[appId].success && steamData[appId].data) {
                            const gameName = steamData[appId].data.name;
                            if (gameNameDisplay) gameNameDisplay.textContent = gameName;
                            console.log(`✅ Steam API'den oyun adı alındı: "${gameName}"`);
                        } else {
                            if (gameNameDisplay) gameNameDisplay.textContent = `Game ${appId}`;
                            console.log(`⚠️ Steam API'de oyun bulunamadı: AppID ${appId}`);
                        }
                    } else {
                        if (gameNameDisplay) gameNameDisplay.textContent = `Game ${appId}`;
                        console.log(`⚠️ Steam API hatası: ${steamResponse.status}`);
                    }
                } catch (steamError) {
                    if (gameNameDisplay) gameNameDisplay.textContent = `Game ${appId}`;
                    console.log(`⚠️ Steam API hatası: ${steamError.message}`);
                }
            } else {
                if (gameNameDisplay) gameNameDisplay.textContent = 'Bilinmeyen Oyun';
                if (gameIdDisplay) gameIdDisplay.textContent = 'Bilinmiyor';
            }
            
            this.selectedManualGameFile = file;
            
        } catch (error) {
            console.error('Manuel oyun dosyası işleme hatası:', error);
            this.showNotification('error', 'Dosya işlenirken hata oluştu', 'error');
        }
    }

    async installManualGame() {
        try {
            if (!this.selectedManualGameFile) {
                this.showNotification('error', 'Lütfen önce bir dosya seçin', 'error');
                return;
            }

            this.showLoading(this.translate('installing_game'));
            
            const tempPath = await this.copyFileToTemp(this.selectedManualGameFile);
            
            const result = await ipcRenderer.invoke('install-manual-game', {
                fileName: this.selectedManualGameFile.name,
                filePath: tempPath
            });

            if (result.success) {
                this.showNotification('success', 'Oyun başarıyla kuruldu!', 'success');
                this.resetManualInstallUI();
            } else {
                this.showNotification('error', result.message || 'Oyun kurulumu başarısız', 'error');
            }
            
        } catch (error) {
            console.error('Manuel oyun kurulum hatası:', error);
            this.showNotification('error', 'Oyun kurulumu sırasında hata oluştu', 'error');
        } finally {
            this.hideLoading();
        }
    }

    async copyFileToTemp(file) {
        try {
            const arrayBuffer = await file.arrayBuffer();
            const buffer = Buffer.from(arrayBuffer);
            
            const tempDir = await ipcRenderer.invoke('get-temp-dir');
            const tempPath = `${tempDir}/${file.name}`;
            
            await ipcRenderer.invoke('write-temp-file', tempPath, buffer);
            
            return tempPath;
        } catch (error) {
            console.error('Dosya kopyalama hatası:', error);
            throw new Error('Dosya kopyalanamadı');
        }
    }

    resetManualInstallUI() {
        const gameInfoSection = document.getElementById('gameInfoSection');
        const installActions = document.getElementById('installActions');
        const gameFileInput = document.getElementById('gameFileInput');
        
        if (gameInfoSection) gameInfoSection.style.display = 'none';
        if (installActions) installActions.style.display = 'none';
        if (gameFileInput) gameFileInput.value = '';
        
        this.selectedManualGameFile = null;
    }

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

    async callAI(message, history = []) {
        try {
            const makeReq = (headerName) => fetch(this.aiApiUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    [headerName]: this.aiApiKey,
                    'Accept': 'application/json'
                },
                body: JSON.stringify({
                    question: message
                })
            });
            let res = await makeReq('X-API-Key');
            let data;
            try {
                data = await res.json();
            } catch {
                const text = await res.text();
                data = { text };
            }
            return data.answer || data.reply || data.message || data.text || '';
        } catch (e) {
            console.error('AI API hatası:', e);
            return '';
        }
    }

    async checkSteamSetup() {
        try {
            console.log('checkSteamSetup called');
            const steamSetupStatus = await ipcRenderer.invoke('get-steam-setup-status');
            console.log('checkSteamSetup result:', steamSetupStatus);
            return steamSetupStatus;
        } catch (error) {
            console.error('Failed to get Steam setup status:', error);
            return {
                hasSteamPath: false,
                hasHidDll: false,
                directoriesCreated: false,
                steamPath: null
            };
        }
    }

    async handleSteamSetupWarnings(steamSetupStatus) {
        console.log('handleSteamSetupWarnings called with:', steamSetupStatus);
        
        const existingWarnings = document.querySelectorAll('.modal-overlay.steam-setup-warning');
        existingWarnings.forEach(warning => warning.remove());
        
        if (steamSetupStatus.hasSteamPath && steamSetupStatus.hasHidDll) {
            if (steamSetupStatus.directoriesCreated) {
                console.log('Directories created, showing notification');
                this.showNotification('success', 'Steam klasörleri başarıyla oluşturuldu', 'success');
            }
            
            console.log('All Steam setup requirements met, no warnings needed');
            return;
        }
        
        if (!steamSetupStatus.hasSteamPath) {
            console.log('Steam path missing, showing warning');
            this.showSteamPathWarning();
            
            setTimeout(() => {
                const modal = document.querySelector('.modal-overlay.steam-setup-warning');
                if (modal) {
                    modal.style.zIndex = '9999';
                    modal.style.display = 'flex';
                }
            }, 1000);
            
            return;
        }

        if (!steamSetupStatus.hasHidDll) {
            console.log('hid.dll missing, showing warning');
            this.showHidDllWarning();
            return;
        }
        
        console.log('No warnings to show');
    }

    showSteamPathWarning() {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay active steam-setup-warning';
        modal.innerHTML = `
            <div class="modal-container">
                <div class="modal-header">
                    <h2>${this.translate('steam_path_required')}</h2>
                </div>
                <div class="modal-content">
                    <div class="warning-icon">⚠️</div>
                    <p>${this.translate('steam_path_not_set')}</p>
                    <p>${this.translate('steam_path_required_for_games')}</p>
                    <div class="modal-actions">
                        <button class="action-btn primary" onclick="window.ui.selectSteamPathAndClose()">${this.translate('select_steam_path')}</button>
                        <button class="action-btn secondary" onclick="window.ui.closeProgram()">${this.translate('close_program')}</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    showHidDllWarning() {
        const modal = document.createElement('div');
        modal.className = 'modal-overlay active steam-setup-warning';
        modal.innerHTML = `
            <div class="modal-container">
                <div class="modal-header">
                    <h2>${this.translate('hid_dll_missing')}</h2>
                </div>
                <div class="modal-content">
                    <div class="warning-icon">⚠️</div>
                    <p>${this.translate('hid_dll_not_found')}</p>
                    <p>${this.translate('hid_dll_required_for_games')}</p>
                    <div class="hid-dll-warning">
                        <p><strong>${this.translate('important_note')}:</strong></p>
                        <p>${this.translate('hid_dll_source_warning')}</p>
                        <p>${this.translate('hid_dll_no_responsibility')}</p>
                        <p>${this.translate('hid_dll_manual_option')}</p>
                    </div>
                    <div class="modal-actions">
                        <button class="action-btn primary" onclick="window.ui.downloadHidDll()">${this.translate('download_hid_dll')}</button>
                        <button class="action-btn secondary" onclick="window.ui.closeProgram()">${this.translate('close_program')}</button>
                    </div>
                </div>
            </div>
        `;
        document.body.appendChild(modal);
    }

    async selectSteamPathAndClose() {
        try {
            const steamPath = await ipcRenderer.invoke('select-steam-path');
            if (steamPath) {
                this.config.steamPath = steamPath;
                await this.updateConfig({ steamPath: steamPath });
                
                console.log('Steam yolu config\'e kaydedildi:', steamPath);
                
                this.showNotification('success', 'Steam yolu başarıyla ayarlandı', 'success');
                
                const steamSetupStatus = await this.checkSteamSetup();
                await this.handleSteamSetupWarnings(steamSetupStatus);
                
                const steamWarningModal = document.querySelector('.modal-overlay.steam-setup-warning');
                if (steamWarningModal) {
                    steamWarningModal.remove();
                }
            }
        } catch (error) {
            console.error('Failed to select Steam path:', error);
            this.showNotification('error', 'Steam yolu seçilemedi', 'error');
        }
    }

    closeProgram() {
        ipcRenderer.invoke('close-program');
    }

    async downloadHidDll() {
        try {
            this.showNotification('info', 'hid.dll indiriliyor...', 'info');
            
            // Discord token'ı al
            const token = await this.getDiscordToken();
            if (!token) {
                this.showNotification('error', 'Discord token bulunamadı', 'error');
                return;
            }
            
            const result = await ipcRenderer.invoke('download-hid-dll', token);
            
            if (result.success) {
                this.showNotification('success', 'hid.dll başarıyla indirildi!', 'success');
                
                const steamSetupStatus = await this.checkSteamSetup();
                
                if (steamSetupStatus.hasHidDll) {
                    this.showNotification('success', 'hid.dll bulundu! Program artık kullanılabilir.', 'success');
                    
                    const steamWarningModal = document.querySelector('.modal-overlay.steam-setup-warning');
                    if (steamWarningModal) {
                        steamWarningModal.remove();
                    }
                    
                    // hid.dll bulundu, sadece modal'ı kapat
                    console.log('✅ hid.dll bulundu, setup tamamlandı');
                    
                    // Ana sayfa zaten açık, sadece oyunları yenile
                    setTimeout(() => {
                        console.log('Oyunlar yenileniyor...');
                        this.loadGames();
                        this.loadLibrary();
                    }, 500);
                } else {
                    this.showNotification('error', 'hid.dll indirildi ama bulunamadı. Lütfen manuel olarak kontrol edin.', 'error');
                }
            } else {
                this.showNotification('error', `hid.dll indirilemedi: ${result.error}`, 'error');
            }
        } catch (error) {
            console.error('Failed to download hid.dll:', error);
            this.showNotification('error', 'hid.dll indirilemedi', 'error');
        }
    }

    async selectSteamPath() {
        try {
            const steamPath = await ipcRenderer.invoke('select-steam-path');
            if (steamPath) {
                document.getElementById('steamPathInput').value = steamPath;
                document.getElementById('setupSteamPath').value = steamPath;
                
                this.config.steamPath = steamPath;
                await this.updateConfig({ steamPath: steamPath });
                
                console.log('Steam yolu config\'e kaydedildi:', steamPath);
                
                this.showNotification('success', 'Steam yolu başarıyla ayarlandı', 'success');
                
                // Steam setup'ı tekrar kontrol et
                const steamSetupStatus = await this.checkSteamSetup();
                
                if (steamSetupStatus.hasSteamPath && steamSetupStatus.hasHidDll) {
                    // Steam setup tamam, modal'ı kapat
                    const steamWarningModal = document.querySelector('.modal-overlay.steam-setup-warning');
                    if (steamWarningModal) {
                        steamWarningModal.remove();
                    }
                    
                    this.showNotification('success', 'Steam setup tamamlandı', 'success');
                    
                    // Steam setup tamam, sadece modal'ı kapat
                    console.log('✅ Steam setup tamam, setup tamamlandı');
                    
                    // Ana sayfa zaten açık, sadece oyunları yenile
                    setTimeout(() => {
                        console.log('Oyunlar yenileniyor...');
                        this.loadGames();
                        this.loadLibrary();
                    }, 500);
                } else if (!steamSetupStatus.hasHidDll) {
                    // hid.dll eksik, uyarı göster
                    this.showSteamSetupCheckScreen(steamSetupStatus);
                }
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
        this.currentPage = page;
        
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
        const pageEl = document.getElementById(page + 'Page');
        if (pageEl) {
            pageEl.classList.add('active');
            pageEl.style.display = '';
            if (page === 'manualInstall') {
                this.setupManualInstallListeners();
            } else if (page === 'repairFix') {
            } else if (page === 'onlinePass') {
                console.log('🔄 Online düzeltme sayfası açıldı, oyunlar yükleniyor...');
                this.loadOnlinePassGames();
            } else if (page === 'library') {
                console.log('🔄 Kütüphane sayfası açıldı, yenileniyor...');
                this.loadLibrary();
            } else if (page === 'home') {
                console.log('🔄 Ana sayfa açıldı, oyunlar yükleniyor...');
                this.loadGames();
            } else if (page === 'bypass') {
                console.log('🔄 Bypass sayfası açıldı, arama barı güncelleniyor...');
            } else if (page === 'settings') {
                console.log('🔄 Ayarlar sayfası açıldı, güncel dil bilgisi kontrol ediliyor...');
                const currentLang = localStorage.getItem('selectedLang') || this.config?.selectedLang || 'tr';
                console.log('Güncel seçili dil:', currentLang);
                this.renderSettingsPage();
            }
        }
        
        this.updateSearchBarForPage();
        
        setTimeout(() => {
            this.applyTranslations();
        }, 100);
    }

    async loadRepairFixGames() {
        try {
            const grid = document.getElementById('repairFixGrid');
            if (!grid) return;
            
            grid.innerHTML = `<div style="color:#fff;opacity:.8;">${this.translate('scanning_games')}</div>`;
            const results = await ipcRenderer.invoke('scan-steam-common');
            grid.innerHTML = '';
            
            const processedAppIds = new Set();
            
            const gameNames = [];
            const gameItems = [];
            
            for (const item of results || []) {
                try {
                    if (item.appid && processedAppIds.has(item.appid)) {
                        console.log(`❌ Duplicate AppID engellendi: ${item.appid} - ${item.gameName || item.folderName}`);
                        continue;
                    }
                    if (item.appid) processedAppIds.add(item.appid);
                    
                    let gameName = item.gameName;
                    if (!gameName || !gameName.trim()) {
                        gameName = item.folderName
                            .replace(/_/g, ' ')
                            .replace(/-/g, ' ')
                            .replace(/\s+/g, ' ')
                            .replace(/\b\w/g, l => l.toUpperCase())
                            .trim();
                    }
                    
                    gameNames.push(gameName);
                    gameItems.push({ ...item, gameName });
                } catch (error) {
                    console.error(`❌ Oyun hazırlama hatası:`, error);
                }
            }
            
            if (gameNames.length === 0) {
                grid.innerHTML = `<div style="color:#fff;opacity:.8;">${this.translate('no_games_found')}</div>`;
                return;
            }
            
            const currentTheme = this.getCurrentTheme();
            const themeColors = this.getThemeColors(currentTheme);
            
            function getThemeColors(theme) {
                const colors = {
                    'modern-blue': {
                        background: 'linear-gradient(135deg, rgba(0, 212, 255, 0.1) 0%, rgba(59, 130, 246, 0.1) 100%)',
                        border: 'rgba(0, 212, 255, 0.3)',
                        shadow: 'rgba(0, 212, 255, 0.2)',
                        textPrimary: '#ffffff',
                        textSecondary: 'rgba(255, 255, 255, 0.8)',
                        textShadow: 'rgba(0, 0, 0, 0.3)',
                        accent: '#00d4ff',
                        accentShadow: 'rgba(0, 212, 255, 0.5)',
                        iconGradient: 'linear-gradient(135deg, #00d4ff, #3b82f6)',
                        iconGlow: 'rgba(0, 212, 255, 0.6)',
                        progressBg: 'rgba(255, 255, 255, 0.15)',
                        progressFill: 'linear-gradient(90deg, #00d4ff, #3b82f6)'
                    },
                    'neon-green': {
                        background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.1) 0%, rgba(16, 185, 129, 0.1) 100%)',
                        border: 'rgba(34, 197, 94, 0.3)',
                        shadow: 'rgba(34, 197, 94, 0.2)',
                        textPrimary: '#ffffff',
                        textSecondary: 'rgba(255, 255, 255, 0.8)',
                        textShadow: 'rgba(0, 0, 0, 0.3)',
                        accent: '#22c55e',
                        accentShadow: 'rgba(34, 197, 94, 0.5)',
                        iconGradient: 'linear-gradient(135deg, #22c55e, #10b981)',
                        iconGlow: 'rgba(34, 197, 94, 0.6)',
                        progressBg: 'rgba(255, 255, 255, 0.15)',
                        progressFill: 'linear-gradient(90deg, #22c55e, #10b981)'
                    },
                    'glass-purple': {
                        background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.1) 0%, rgba(168, 85, 247, 0.1) 100%)',
                        border: 'rgba(139, 92, 246, 0.3)',
                        shadow: 'rgba(139, 92, 246, 0.2)',
                        textPrimary: '#ffffff',
                        textSecondary: 'rgba(255, 255, 255, 0.8)',
                        textShadow: 'rgba(0, 0, 0, 0.3)',
                        accent: '#8b5cf6',
                        accentShadow: 'rgba(139, 92, 246, 0.5)',
                        iconGradient: 'linear-gradient(135deg, #8b5cf6, #a855f7)',
                        iconGlow: 'rgba(139, 92, 246, 0.6)',
                        progressBg: 'rgba(255, 255, 255, 0.15)',
                        progressFill: 'linear-gradient(90deg, #8b5cf6, #a855f7)'
                    },
                    'minimal-dark': {
                        background: 'linear-gradient(135deg, rgba(31, 41, 55, 0.95) 0%, rgba(17, 24, 39, 0.95) 100%)',
                        border: 'rgba(75, 85, 99, 0.3)',
                        shadow: 'rgba(0, 0, 0, 0.4)',
                        textPrimary: '#ffffff',
                        textSecondary: 'rgba(255, 255, 255, 0.7)',
                        textShadow: 'rgba(0, 0, 0, 0.5)',
                        accent: '#60a5fa',
                        accentShadow: 'rgba(96, 165, 250, 0.5)',
                        iconGradient: 'linear-gradient(135deg, #60a5fa, #3b82f6)',
                        iconGlow: 'rgba(96, 165, 250, 0.6)',
                        progressBg: 'rgba(255, 255, 255, 0.1)',
                        progressFill: 'linear-gradient(90deg, #60a5fa, #3b82f6)'
                    },
                    'retro-orange': {
                        background: 'linear-gradient(135deg, rgba(251, 146, 60, 0.1) 0%, rgba(245, 101, 101, 0.1) 100%)',
                        border: 'rgba(251, 146, 60, 0.3)',
                        shadow: 'rgba(251, 146, 60, 0.2)',
                        textPrimary: '#ffffff',
                        textSecondary: 'rgba(255, 255, 255, 0.8)',
                        textShadow: 'rgba(0, 0, 0, 0.3)',
                        accent: '#fb923c',
                        accentShadow: 'rgba(251, 146, 60, 0.5)',
                        iconGradient: 'linear-gradient(135deg, #fb923c, #f56565)',
                        iconGlow: 'rgba(251, 146, 60, 0.6)',
                        progressBg: 'rgba(255, 255, 255, 0.15)',
                        progressFill: 'linear-gradient(90deg, #fb923c, #f56565)'
                    }
                };
                
                return colors[theme] || colors['modern-blue'];
            }
            
            grid.innerHTML = `
                <div class="online-fix-progress" style="
                    display: flex;
                    flex-direction: column;
                    align-items: center;
                    justify-content: center;
                    min-height: 400px;
                    padding: 30px 20px;
                    text-align: center;
                    background: ${themeColors.background};
                    border-radius: 16px;
                    border: 1px solid ${themeColors.border};
                    backdrop-filter: blur(8px);
                    margin: 20px;
                    position: absolute;
                    top: 50%;
                    left: 50%;
                    transform: translate(-50%, -50%);
                    width: calc(100% - 40px);
                    max-width: 450px;
                    box-shadow: 0 8px 32px ${themeColors.shadow};
                ">
                    <div class="progress-icon" style="
                        width: 60px;
                        height: 60px;
                        background: ${themeColors.iconGradient};
                        border-radius: 50%;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        margin-bottom: 20px;
                        animation: pulse 2s infinite;
                        box-shadow: 0 0 20px ${themeColors.iconGlow};
                    ">
                        <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 12a9 9 0 11-6.219-8.56"/>
                            <path d="M12 3v9l3.5 3.5"/>
                        </svg>
                    </div>
                    
                    <h2 style="
                        color: ${themeColors.textPrimary};
                        font-size: 22px;
                        font-weight: 600;
                        margin: 0 0 12px 0;
                        text-shadow: 0 1px 5px ${themeColors.textShadow};
                    ">${this.translate('checking_online_fixes')}</h2>
                    
                    <div class="progress-stats" style="
                        color: ${themeColors.accent};
                        font-size: 16px;
                        font-weight: 500;
                        margin-bottom: 20px;
                        text-shadow: 0 1px 3px ${themeColors.accentShadow};
                    ">${gameNames.length} ${this.translate('games_being_checked')}</div>
                    
                    <div class="progress-bar-container" style="
                        width: 100%;
                        max-width: 300px;
                        height: 6px;
                        background: ${themeColors.progressBg};
                        border-radius: 3px;
                        overflow: hidden;
                        position: relative;
                    ">
                        <div class="progress-bar-fill" style="
                            height: 100%;
                            background: ${themeColors.progressFill};
                            border-radius: 3px;
                            width: 0%;
                            transition: width 0.3s ease;
                            position: relative;
                        "></div>
                    </div>
                    
                    <div class="progress-text" style="
                        color: ${themeColors.textSecondary};
                        font-size: 13px;
                        margin-top: 12px;
                        font-style: italic;
                    ">${this.translate('scanning_online_fix_database')}</div>
                </div>
                
                <style>
                    @keyframes pulse {
                        0% { transform: scale(1); box-shadow: 0 0 30px rgba(0, 212, 255, 0.5); }
                        50% { transform: scale(1.05); box-shadow: 0 0 40px rgba(0, 212, 255, 0.7); }
                        100% { transform: scale(1); box-shadow: 0 0 30px rgba(0, 212, 255, 0.5); }
                    }
                    
                    .online-fix-progress {
                        animation: fadeInUp 0.5s ease-out;
                    }
                    
                    @keyframes fadeInUp {
                        from { opacity: 0; transform: translateY(20px); }
                        to { opacity: 1; transform: translateY(0); }
                    }
                </style>
            `;
            
            console.log(`🚀 ${gameNames.length} oyun için paralel fix kontrolü başlatılıyor...`);
            const fixResults = await ipcRenderer.invoke('check-multiple-repair-fix', gameNames);
                    
            grid.innerHTML = '';
            let fixCount = 0;
            
            this.repairFixGames = [];
            
            for (let i = 0; i < gameItems.length; i++) {
                const item = gameItems[i];
                const gameName = gameNames[i];
                const hasFix = fixResults[gameName];
                
                    if (hasFix === true) {
                        this.repairFixGames.push({
                            appid: item.appid,
                            gameName: gameName,
                            folderName: item.folderName,
                            fullPath: item.fullPath,
                            installedFix: item.installedFix
                        });
                        
                        const card = await this.createRepairFixCard(item);
                        if (card) {
                            grid.appendChild(card);
                        fixCount++;
                            console.log(`✅ Kart eklendi: ${gameName} (AppID: ${item.appid})`);
                        }
                    }
            }
            
            if (fixCount === 0) {
                grid.innerHTML = `
                    <div class="no-fixes-found" style="
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        min-height: 350px;
                        padding: 30px 20px;
                        text-align: center;
                        background: ${themeColors.background};
                        border-radius: 16px;
                        border: 1px solid ${themeColors.border};
                        backdrop-filter: blur(8px);
                        margin: 20px;
                        position: absolute;
                        top: 50%;
                        left: 50%;
                        transform: translate(-50%, -50%);
                        width: calc(100% - 40px);
                        max-width: 450px;
                        box-shadow: 0 8px 32px ${themeColors.shadow};
                    ">
                        <div class="no-fixes-icon" style="
                            width: 60px;
                            height: 60px;
                            background: ${themeColors.iconGradient};
                            border-radius: 50%;
                            display: flex;
                            align-items: center;
                            justify-content: center;
                            margin-bottom: 20px;
                            box-shadow: 0 0 20px ${themeColors.iconGlow};
                        ">
                            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="10"/>
                                <line x1="15" y1="9" x2="9" y2="15"/>
                                <line x1="9" y1="9" x2="15" y2="15"/>
                            </svg>
                        </div>
                        
                        <h2 style="
                            color: ${themeColors.textPrimary};
                            font-size: 22px;
                            font-weight: 600;
                            margin: 0 0 12px 0;
                            text-shadow: 0 1px 5px ${themeColors.textShadow};
                        ">${this.translate('no_online_fixes_found')}</h2>
                        
                        <div class="scan-summary" style="
                            color: ${themeColors.accent};
                            font-size: 16px;
                            font-weight: 500;
                            margin-bottom: 20px;
                            text-shadow: 0 1px 3px ${themeColors.accentShadow};
                        ">${gameNames.length} ${this.translate('games_scanned')}</div>
                        
                        <div class="info-text" style="
                            color: ${themeColors.textSecondary};
                            font-size: 13px;
                            max-width: 350px;
                            line-height: 1.5;
                        ">
                            ${this.translate('no_online_fixes_info')}
                        </div>
                    </div>
                `;
            } else {
                console.log(`✅ Toplam ${fixCount} oyun için fix bulundu`);
            }
            
        } catch (e) {
            console.error('RepairFix load error:', e);
            this.showNotification('error', this.translate('an_error_occurred'), 'error');
        }
    }

    async loadBypassGames() {
        try {
            const grid = document.getElementById('bypassGrid');
            if (!grid) return;
            
            this.showBypassProgress();
            
            const token = await this.getDiscordToken();
            if (!token) {
                grid.innerHTML = `<div style="color:#fff;opacity:.8;">${this.translate('discord_token_required')}</div>`;
                return;
            }
            
            const games = await this.fetchBypassGames(token);
            
            this.bypassGames = games;
            
            await this.renderBypassGames(games, grid);
            
        } catch (error) {
            console.error('Bypass games load error:', error);
            
            if (error.message && error.message.includes('401_UNAUTHORIZED')) {
                this.showBypassRoleModal();
            } else {
                this.showBypassError(error.message);
            }
        }
    }

    async fetchBypassGames(token) {
        try {
            const response = await fetch('https://api.muhammetdag.com/steamlib/bypass/bypass.php', {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/json',
                    'User-Agent': 'Paradise-Steam-Library/1.0'
                }
            });

            if (!response.ok) {
                if (response.status === 401) {
                    throw new Error('401_UNAUTHORIZED');
                }
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            
            if (!data.success || !Array.isArray(data.games)) {
                throw new Error('Invalid API response format');
            }

            console.log(`✅ ${data.games.length} bypass oyunu API'den alındı`);
            return data.games;
            
        } catch (error) {
            console.error('Bypass games API hatası:', error);
            throw error;
        }
    }

    async renderBypassGames(games, container) {
        container.innerHTML = '';
        
        if (games.length === 0) {
            this.showNoBypassFound();
            return;
        }

        
        
        for (const game of games) {
            try {
                const card = await this.createBypassCard(game);
                if (card) container.appendChild(card);
            } catch (error) {
                console.error(`Bypass card oluşturma hatası (${game.name}):`, error);
            }
        }
    }

    async createBypassCard(game) {
        const card = document.createElement('div');
        card.className = 'game-card';
        
        const steamid = game.id; // API'den gelen id alanı (steamid olarak kullanılıyor)
        const gameName = game.name;
        const fileName = game.file;
        
        let header = '';
        try {
            header = await this.getSharedHeader(steamid);
        } catch (error) {
            console.log(`Header image alınamadı (${steamid}):`, error);
            header = 'pdbanner.png'; // Fallback image
        }
        
        const bypassStatus = await this.checkBypassStatus(steamid);
        
        let badge, actionBtn;
        
        if (bypassStatus.installed) {
            badge = `<span class="bypass-badge installed">${this.translate('installed')}</span>`;
            actionBtn = `<button class="game-btn danger" data-action="remove">${this.translate('remove_bypass')}</button>`;
        } else {
            badge = `<span class="bypass-badge ready">${this.translate('ready')}</span>`;
            actionBtn = `<button class="game-btn success" data-action="install">${this.translate('download_bypass')}</button>`;
        }
        
        card.innerHTML = `
            <img src="${header}" alt="${gameName}" class="game-image" loading="lazy" onerror="this.onerror=null;this.src='pdbanner.png'" data-steamid="${steamid}" data-fallback="0">
            <div class="game-info">
                <h3 class="game-title">${gameName}</h3>
                <div class="game-meta" style="gap:8px;align-items:center;display:flex;justify-content:space-between;">
                    ${badge}
                    <span style="color:#94a3b8;font-size:12px;">SteamID: ${steamid}</span>
                </div>
                <div class="game-actions">
                    ${actionBtn}
                </div>
            </div>
        `;
        
        const actionButton = card.querySelector('[data-action]');
        if (actionButton) {
            actionButton.onclick = async (e) => {
                e.stopPropagation();
                const action = actionButton.dataset.action;
                
                if (action === 'install') {
                    await this.handleInstallBypass({ appid: steamid, gameName, fileName, card });
                } else if (action === 'remove') {
                    await this.handleRemoveBypass({ appid: steamid, gameName, card });
                }
            };
        }
        
        return card;
    }

    async checkBypassStatus(steamid) {
        try {
            const result = await ipcRenderer.invoke('check-bypass-status', steamid);
            return result || { installed: false };
        } catch (error) {
            console.error('Bypass status kontrolü hatası:', error);
            return { installed: false };
        }
    }

    async handleInstallBypass({ appid, gameName, fileName, card }) {
        try {
            this.showLoading(this.translate('downloading_bypass_archive'));
            
            const gameDir = await this.selectGameDirectory(gameName);
            if (!gameDir) return;
            
            this.showLoading(this.translate('installing_bypass_archive'));
            
            const result = await this.downloadAndInstallBypass(appid, fileName, gameDir);
            
            if (result.success) {
                this.showNotification('success', this.translate('bypass_installed'), 'success');
                this.updateBypassCardUI(card, true);
            } else {
                throw new Error(result.error || 'Installation failed');
            }
            
        } catch (error) {
            console.error('Bypass kurulum hatası:', error);
            
            let errorMessage = error.message;
            if (error.message.includes('extractZip') || error.message.includes('extraction failed')) {
                errorMessage = 'ZIP dosyası çıkarılamadı - 7-Zip veya WinRAR kurulu olmayabilir';
            } else if (error.message.includes('API hatası')) {
                errorMessage = 'API hatası - Token geçersiz olabilir';
            } else if (error.message.includes('Discord token bulunamadı')) {
                errorMessage = 'Discord token bulunamadı - Lütfen Discord token\'ınızı girin';
            } else if (error.message.includes('permission')) {
                errorMessage = 'İzin hatası - yönetici olarak çalıştırmayı deneyin';
            }
            
            this.showNotification('error', errorMessage, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async handleRemoveBypass({ appid, gameName, card }) {
        try {
            this.showLoading(this.translate('removing_bypass'));
            
            const result = await ipcRenderer.invoke('remove-bypass', appid);
            
            if (result.success) {
                this.showNotification('success', this.translate('bypass_removed'), 'success');
                this.updateBypassCardUI(card, false);
            } else {
                throw new Error(result.error || 'Removal failed');
            }
            
        } catch (error) {
            console.error('Bypass kaldırma hatası:', error);
            this.showNotification('error', error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async selectGameDirectory(gameName) {
        try {
            const result = await ipcRenderer.invoke('select-directory', `${gameName} için oyun dizinini seçin`);
            
            if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
                return null;
            }
            
            return result.filePaths[0];
        } catch (error) {
            console.error('Dizin seçimi hatası:', error);
            throw new Error('Dizin seçimi başarısız');
        }
    }

    async downloadAndInstallBypass(steamid, fileName, targetDir) {
        try {
            if (!steamid || !fileName || !targetDir) {
                throw new Error('Eksik parametreler: steamid, fileName veya targetDir');
            }
            
            const steamIdStr = String(steamid);
            
            const token = await this.getDiscordToken();
            
            const result = await ipcRenderer.invoke('download-and-install-bypass', {
                appid: steamIdStr, // Main process'te steamid olarak kullanılıyor
                fileName,
                targetDir,
                token
            });
            
            return result;
        } catch (error) {
            console.error('Bypass indirme hatası:', error);
            throw error;
        }
    }

    updateBypassCardUI(card, installed) {
        const badge = card.querySelector('.bypass-badge');
        const actionBtn = card.querySelector('[data-action]');
        
        if (installed) {
            badge.textContent = this.translate('installed');
            badge.className = 'bypass-badge installed';
            actionBtn.textContent = this.translate('remove_bypass');
            actionBtn.className = 'game-btn danger';
            actionBtn.dataset.action = 'remove';
        } else {
            badge.textContent = this.translate('ready');
            badge.className = 'bypass-badge ready';
            actionBtn.textContent = this.translate('download_bypass');
            actionBtn.className = 'game-btn success';
            actionBtn.dataset.action = 'install';
        }
    }

    showBypassProgress() {
        const bypassGrid = document.getElementById('bypassGrid');
        if (!bypassGrid) return;
        
        const currentTheme = this.getCurrentTheme();
        const themeColors = this.getThemeColors(currentTheme);
        
        bypassGrid.innerHTML = `
            <div class="bypass-progress" style="
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                min-height: 400px;
                padding: 60px 20px;
                text-align: center;
                background: ${themeColors.background};
                border-radius: 16px;
                border: 1px solid ${themeColors.border};
                backdrop-filter: blur(8px);
                margin: 20px;
                box-shadow: 0 8px 32px ${themeColors.shadow};
                animation: fadeInUp 0.5s ease-out;
            ">
                <div style="
                    width: 80px;
                    height: 80px;
                    background: ${themeColors.iconGradient};
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin-bottom: 24px;
                    box-shadow: 0 8px 32px ${themeColors.iconGlow};
                    animation: pulse 2s infinite;
                ">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: white;">
                        <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                        <path d="M12 2v2"/>
                        <path d="M12 20v2"/>
                        <path d="M4.93 4.93l1.41 1.41"/>
                        <path d="M17.66 17.66l1.41 1.41"/>
                        <path d="M2 12h2"/>
                        <path d="M20 12h2"/>
                        <path d="M6.34 17.66l-1.41 1.41"/>
                        <path d="M19.07 4.93l-1.41 1.41"/>
                    </svg>
                </div>
                <h2 style="
                    color: ${themeColors.textPrimary};
                    margin: 0 0 12px 0;
                    font-size: 24px;
                    font-weight: 700;
                    text-shadow: 0 2px 4px ${themeColors.textShadow};
                ">${this.translate('loading_bypass_games')}</h2>
                <div style="
                    color: ${themeColors.textSecondary};
                    font-size: 16px;
                    opacity: 0.9;
                    max-width: 400px;
                    line-height: 1.5;
                    margin-bottom: 24px;
                ">${this.translate('fetching_bypass_database')}</div>
                <div style="
                    width: 200px;
                    height: 4px;
                    background: ${themeColors.progressBg};
                    border-radius: 2px;
                    overflow: hidden;
                    position: relative;
                ">
                    <div style="
                        width: 100%;
                        height: 100%;
                        background: ${themeColors.progressFill};
                        border-radius: 2px;
                        animation: progressBar 2s ease-in-out infinite;
                    "></div>
                </div>
            </div>
        `;
    }

    showNoBypassFound() {
        const bypassGrid = document.getElementById('bypassGrid');
        if (!bypassGrid) return;
        
        const currentTheme = this.getCurrentTheme();
        const themeColors = this.getThemeColors(currentTheme);
        
        bypassGrid.innerHTML = `
            <div style="
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 60px 20px;
                text-align: center;
                min-height: 400px;
            ">
                <div style="
                    width: 80px;
                    height: 80px;
                    background: ${themeColors.iconGradient};
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin-bottom: 24px;
                    box-shadow: 0 8px 32px ${themeColors.iconGlow};
                ">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: white;">
                        <path d="M21 12c-1 0-3-1-3-3s2-3 3-3 3 1 3 3-2 3-3 3"/>
                        <path d="M6 12c1 0 3-1 3-3s-2-3-3-3-3 1-3 3 2 3 3 3"/>
                        <path d="M12 21c0-1-1-3-3-3s-3 2-3 3 1 3 3 3 3-2 3-3"/>
                        <path d="M12 3c0 1-1 3-3 3s-3-2-3-3 1-3 3-3 3 2 3 3"/>
                    </svg>
                </div>
                <h2 style="
                    color: ${themeColors.textPrimary};
                    margin: 0 0 12px 0;
                    font-size: 24px;
                    font-weight: 700;
                    text-shadow: 0 2px 4px ${themeColors.textShadow};
                ">${this.translate('no_bypass_found')}</h2>
                <div style="
                    color: ${themeColors.textSecondary};
                    font-size: 16px;
                    opacity: 0.9;
                    max-width: 400px;
                    line-height: 1.5;
                ">
                    ${this.translate('no_bypass_info')}
                </div>
            </div>
        `;
    }

    showBypassError(errorMessage) {
        const bypassGrid = document.getElementById('bypassGrid');
        if (!bypassGrid) return;
        
        bypassGrid.innerHTML = `
            <div style="
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                padding: 60px 20px;
                text-align: center;
                min-height: 400px;
            ">
                <div style="
                    width: 80px;
                    height: 80px;
                    background: linear-gradient(135deg, #ef4444, #dc2626);
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    margin-bottom: 24px;
                    box-shadow: 0 8px 32px rgba(239, 68, 68, 0.4);
                ">
                    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="color: white;">
                        <circle cx="12" cy="12" r="10"/>
                        <line x1="15" y1="9" x2="9" y2="15"/>
                        <line x1="9" y1="9" x2="15" y2="15"/>
                    </svg>
                </div>
                <h2 style="color: #ffffff; margin: 0 0 12px 0; font-size: 24px; font-weight: 700;">
                    ${this.translate('error_occurred')}
                </h2>
                <div style="color: rgba(255, 255, 255, 0.8); font-size: 16px; opacity: 0.9; max-width: 400px; line-height: 1.5;">
                    ${errorMessage}
                </div>
            </div>
        `;
    }



    async displayBypassSearchResults(games, container) {
        const existingCards = container.querySelectorAll('.game-card');
        existingCards.forEach(card => card.remove());
        
        if (games.length === 0) {
            container.innerHTML = '';
            return;
        }
        

        
        for (const game of games) {
            try {
                const card = await this.createBypassCard(game);
                if (card) container.appendChild(card);
            } catch (error) {
                console.error(`Bypass card oluşturma hatası (${game.name}):`, error);
            }
        }
    }

    async performRepairFixSearch(query) {
        try {
            const grid = document.getElementById('repairFixGrid');
            if (!grid) return;
            
            if (!this.repairFixGames) {
                await this.loadRepairFixGames();
                return;
            }
            
            const results = this.repairFixGames.filter(game => {
                const nameMatch = game.gameName.toLowerCase().includes(query.toLowerCase());
                const idMatch = game.appid.toString().includes(query);
                return nameMatch || idMatch;
            });
            
            await this.displayRepairFixSearchResults(results, grid);
            
        } catch (error) {
            console.error('Online fix arama hatası:', error);
            this.showNotification('error', 'Arama sırasında hata oluştu', 'error');
        }
    }

    async performBypassSearch(query) {
        try {
            const grid = document.getElementById('bypassGrid');
            if (!grid) return;
            
            if (!this.bypassGames) {
                await this.loadBypassGames();
                return;
            }
            
            const results = this.bypassGames.filter(game => {
                const nameMatch = game.name.toLowerCase().includes(query.toLowerCase());
                const idMatch = game.id.toString().includes(query);
                return nameMatch || idMatch;
            });
            
            await this.displayBypassSearchResults(results, grid);
            
        } catch (error) {
            console.error('Bypass arama hatası:', error);
            this.showNotification('error', 'Arama sırasında hata oluştu', 'error');
        }
    }

    async performLibrarySearch(query) {
        try {
            const grid = document.getElementById('libraryGrid');
            if (!grid) return;
            
            if (!this.libraryGames || this.libraryGames.length === 0) {
                await this.loadLibrary();
                return;
            }
            
            const results = this.libraryGames.filter(game => {
                const nameMatch = game.name.toLowerCase().includes(query.toLowerCase());
                const idMatch = game.appid.toString().includes(query);
                return nameMatch || idMatch;
            });
            
            await this.displayLibrarySearchResults(results, grid);
            
        } catch (error) {
            console.error('Kütüphane arama hatası:', error);
            this.showNotification('error', 'Arama sırasında hata oluştu', 'error');
        }
    }

    async displayRepairFixSearchResults(results, grid) {
        grid.innerHTML = '';
        
        if (results.length === 0) {
            grid.innerHTML = '';
            return;
        }
        

        
        for (const game of results) {
            try {
                const card = await this.createRepairFixCard(game);
                if (card) grid.appendChild(card);
            } catch (error) {
                console.error(`Online fix card oluşturma hatası (${game.gameName}):`, error);
            }
        }
    }

    async displayLibrarySearchResults(results, grid) {
        grid.innerHTML = '';
        
        if (results.length === 0) {
            grid.innerHTML = '';
            return;
        }
        

        
        for (const game of results) {
            try {
                const card = await this.createGameCard(game, true);
                if (card) grid.appendChild(card);
            } catch (error) {
                console.error(`Kütüphane card oluşturma hatası (${game.name}):`, error);
            }
        }
    }

    async createRepairFixCard(entry) {
        const { folderName, gameName, appid, fullPath, installedFix } = entry;
        console.log(`Repair Fix Card oluşturuluyor:`, { folderName, gameName, appid, fullPath, installedFix });
        const card = document.createElement('div');
        card.className = 'game-card';
        let title;
        if (gameName && gameName.trim()) {
            title = gameName.trim();
        } else {
            title = folderName
                .replace(/_/g, ' ')
                .replace(/-/g, ' ')
                .replace(/\s+/g, ' ')
                .replace(/\b\w/g, l => l.toUpperCase())
                .trim();
        }
        console.log(`Title seçildi: "${title}" (gameName: "${gameName}", folderName: "${folderName}")`);
        const header = await this.getSharedHeader(appid || '');
        
        let badge, installBtn, uninstallBtn;
        
        if (installedFix) {
            badge = `<span class="repair-badge installed">${this.translate('installed')}</span>`;
            installBtn = `<button class="game-btn primary" data-action="install" style="display:none;">${this.translate('install_fix')}</button>`;
            uninstallBtn = `<button class="game-btn danger" data-action="uninstall">${this.translate('uninstall_fix')}</button>`;
        } else {
            badge = `<span class="repair-badge ready">${this.translate('ready')}</span>`;
            installBtn = `<button class="game-btn success" data-action="install">${this.translate('install_fix')}</button>`;
            uninstallBtn = `<button class="game-btn secondary" data-action="uninstall" disabled style="display:none;">${this.translate('uninstall_fix')}</button>`;
        }
        
        card.innerHTML = `
            <img src="${header}" alt="${title}" class="game-image" loading="lazy" onerror="this.onerror=null;this.src='pdbanner.png'" data-appid="${appid}" data-fallback="0">
            <div class="game-info">
                <h3 class="game-title">${title}</h3>
                <div class="game-meta" style="gap:8px;align-items:center;display:flex;justify-content:space-between;">
                    ${badge}
                    <span style="color:#94a3b8;font-size:12px;">${folderName}</span>
                </div>
                <div class="game-actions">
                    ${installBtn}
                    ${uninstallBtn}
                </div>
            </div>
        `;
        
        const installButton = card.querySelector('[data-action="install"]');
        const uninstallButton = card.querySelector('[data-action="uninstall"]');
        
        if (installButton) {
            installButton.onclick = async (e) => {
                e.stopPropagation();
                await this.handleInstallRepairFix({ folderName, gameName: title, appid, fullPath, card });
            };
        }
        
        if (uninstallButton) {
            uninstallButton.onclick = async (e) => {
                e.stopPropagation();
                await this.handleUninstallRepairFix({ folderName, gameName: title, fullPath, card });
            };
        }
        
        return card;
    }



    async handleInstallRepairFix({ folderName, gameName, appid, fullPath, card }) {
        try {
            this.showLoading(this.translate('downloading'));
            const listHtml = await ipcRenderer.invoke('list-repair-fix-files', gameName || folderName);
            const rarFiles = (listHtml || '').match(/href="([^"]+\.rar)"/gi)?.map(m => m.replace(/href="|"/g, '')) || [];
            if (rarFiles.length === 0) {
                this.showNotification('error', this.translate('no_files_found'), 'error');
                return;
            }
            let selectedFile = rarFiles[0];
            if (rarFiles.length > 1) {
                selectedFile = await this.promptSelectRepairFile(rarFiles);
                if (!selectedFile) return;
            }
            await ipcRenderer.invoke('download-and-install-repair-fix', {
                folderName: gameName || folderName,  // gameName kullan, yoksa folderName
                targetDir: fullPath,
                fileName: selectedFile
            });
            this.showNotification('success', this.translate('installation_complete'), 'success');
            this.updateRepairFixCardAfterInstall(card);
        } catch (e) {
            console.error('Install repair fix error:', e);
            this.showNotification('error', this.translate('installation_failed'), 'error');
        } finally {
            this.hideLoading();
        }
    }

    async handleUninstallRepairFix({ folderName, gameName, fullPath, card }) {
        try {
            this.showLoading(this.translate('uninstalling'));
            await ipcRenderer.invoke('uninstall-repair-fix', { folderName: gameName || folderName, targetDir: fullPath });
            this.showNotification('success', this.translate('uninstallation_complete'), 'success');
            this.updateRepairFixCardAfterUninstall(card);
        } catch (e) {
            console.error('Uninstall repair fix error:', e);
            this.showNotification('error', this.translate('uninstallation_failed'), 'error');
        } finally {
            this.hideLoading();
        }
    }

    updateRepairFixCardAfterInstall(card) {
        const badge = card.querySelector('.repair-badge');
        const installBtn = card.querySelector('[data-action="install"]');
        const uninstallBtn = card.querySelector('[data-action="uninstall"]');
        
        if (badge) {
            badge.textContent = this.translate('installed');
            badge.className = 'repair-badge installed';
        }
        
        if (installBtn) {
            installBtn.style.display = 'none';
        }
        
        if (uninstallBtn) {
            uninstallBtn.style.display = 'inline-block';
            uninstallBtn.disabled = false;
            uninstallBtn.className = 'game-btn danger'; // Kırmızı renk
        }
    }

    updateRepairFixCardAfterUninstall(card) {
        const badge = card.querySelector('.repair-badge');
        const installBtn = card.querySelector('[data-action="install"]');
        const uninstallBtn = card.querySelector('[data-action="uninstall"]');
        
        if (badge) {
            badge.textContent = this.translate('ready');
            badge.className = 'repair-badge ready';
        }
        
        if (installBtn) {
            installBtn.style.display = 'inline-block';
            installBtn.className = 'game-btn success'; // Yeşil renk
        }
        
        if (uninstallBtn) {
            uninstallBtn.style.display = 'none';
        }
    }

    async promptSelectRepairFile(files) {
        return new Promise(resolve => {
            const modal = document.createElement('div');
            modal.className = 'modal-overlay active';
            modal.innerHTML = `
                <div class="modal-container small">
                    <div class="modal-header"><h2>${this.translate('select_file_to_download')}</h2><button class="modal-close" id="rfClose">×</button></div>
                    <div class="modal-content">
                        <div class="dlc-list" id="rfList"></div>
                        <div class="modal-actions">
                            <button class="action-btn secondary" id="rfCancel">${this.translate('cancel')}</button>
                        </div>
                    </div>
                </div>`;
            document.body.appendChild(modal);
            const list = modal.querySelector('#rfList');
            files.forEach(f => {
                const btn = document.createElement('button');
                btn.className = 'action-btn primary';
                btn.textContent = f;
                btn.onclick = () => { cleanup(); resolve(f); };
                list.appendChild(btn);
            });
            const cleanup = () => { modal.remove(); };
            modal.querySelector('#rfCancel').onclick = () => { cleanup(); resolve(null); };
            modal.querySelector('#rfClose').onclick = () => { cleanup(); resolve(null); };
        });
    }

    switchCategory(category) {
        document.querySelectorAll('.nav-tab').forEach(tab => {
            tab.classList.remove('active');
        });
        document.querySelector(`[data-category="${category}"]`).classList.add('active');

        const categoryNames = {
            'featured': this.translate('featured_games'),
            'popular': this.translate('popular_games'),
            'new': this.translate('new_games'),
            'top': this.translate('top_games'),
            'free': this.translate('free_games'),
            'action': this.translate('action_games'),
            'rpg': this.translate('rpg_games'),
            'strategy': this.translate('strategy_games')
        };
        
        document.getElementById('sectionTitle').textContent = categoryNames[category] || this.translate('games');

        this.currentCategory = category;
        this.loadGames();
    }

    async loadAllGames() {

        this.showLoading();
        try {
            const cc = this.countryCode || 'TR';
            const lang = this.getSelectedLang();
            
            const resultsUrl = `https://store.steampowered.com/search/results?sort_by=Reviews_DESC&category1=998&force_infinite=1&start=0&count=50&supportedlang=turkish&ndl=1&snr=1_7_7_151_7`;
            
            try {
                console.log(this.translate('getting_steam_search_results'));
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
                    throw new Error(this.translate('steam_search_no_results'));
                }
                
                console.log(`${rows.length} ${this.translate('games_found')}, ${this.translate('getting_details')}...`);
                
                const newGamesRaw = Array.from(rows).map(row => {
                    const appid = row.getAttribute('data-ds-appid');
                    const name = row.querySelector('.title')?.textContent?.trim() || '';
                    return { appid, name };
                }).filter(game => game.appid && game.name);
                
                const games = await Promise.allSettled(newGamesRaw.slice(0, 50).map(async (game, index) => {
                    try {
                        console.log(`${this.translate('getting_game_details')} ${game.appid}...`);
                        const gameData = await fetchSteamAppDetails(game.appid, cc, lang);
                        
                        if (!gameData || !gameData.name) {
                            throw new Error(this.translate('game_data_not_found'));
                        }
                        
                        console.log(`${this.translate('game_successfully_loaded')} ${game.appid}: ${gameData.name}`);
                        
                        const headerImage = await this.getSharedHeader(game.appid);
                        return {
                            appid: game.appid,
                            name: gameData.name,
                            header_image: headerImage,
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
                        console.error(`${this.translate('error_loading_game')} ${game.appid}:`, error);
                        const headerImage = await this.getSharedHeader(game.appid);
                        return {
                            appid: game.appid,
                            name: game.name || `${this.translate('game')} ${game.appid}`,
                            header_image: headerImage,
                            price: 0,
                            price_overview: null,
                            discount_percent: 0,
                            platforms: {},
                            coming_soon: false,
                            tags: [],
                            genres: [],
                            short_description: this.translate('game_info_load_failed'),
                            reviews: '',
                            metacritic: null,
                            release_date: null,
                            is_dlc: false
                        };
                    }
                }));
                
                this.gamesData = games
                    .filter(result => result.status === 'fulfilled' && result.value)
                    .map(result => result.value);
                
                this.filteredAllGames = [...this.gamesData];
                
                if (this.gamesData.length > 0) {
                    console.log(`${this.gamesData.length} ${this.translate('games_successfully_loaded')}`);
                    this.sortAllGames();
                    this.renderFilteredAllGames();
                    this.updateAllGamesFilterResults();
                } else {
                    throw new Error(this.translate('no_games_loaded'));
                }
                
            } catch (searchError) {
                console.error(this.translate('steam_search_error'), searchError);
                throw new Error(this.translate('steam_search_results_failed'));
            }
            
        } catch (error) {
            console.error(this.translate('general_error_loading_games'), error);
            
            const fallbackAppIds = [1436990,2300230,2255360,2418490,2358720,2749880,1593500,3181470,1941540,1174180];
                        const fallbackGames = [];
            for (const appid of fallbackAppIds) {
                const headerImage = await this.getSharedHeader(appid);
                fallbackGames.push({
                    appid: appid,
                    name: `${this.translate('game')} ${appid}`,
                    header_image: headerImage,
                    price: 0,
                    price_overview: null,
                    discount_percent: 0,
                    platforms: {},
                    coming_soon: false,
                    tags: [],
                    genres: [],
                    short_description: this.translate('game_info_load_failed'),
                    reviews: '',
                    metacritic: null,
                    release_date: null,
                    is_dlc: false
                });
            }
            
            this.gamesData = fallbackGames;
            this.filteredAllGames = [...this.gamesData];
            this.renderFilteredAllGames();
            this.updateAllGamesFilterResults();
            
            this.showNotification('Uyarı', 'Bazı oyun bilgileri yüklenemedi. Temel bilgiler gösteriliyor.', 'warning');
        } finally {
            this.hideLoading();
        }
    }


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
            
            const fallbackGames = [];
            for (const appid of featuredAppIds.slice(0, 10)) {
                                const headerImage = await this.getSharedHeader(appid);
                fallbackGames.push({
                    appid: appid,
                    name: `${this.translate('game')} ${appid}`,
                    header_image: headerImage,
                    price: 0,
                    price_overview: null,
                    discount_percent: 0,
                    platforms: {},
                    coming_soon: false,
                    tags: [],
                    genres: [],
                    short_description: this.translate('loading_game_info'),
                    reviews: '',
                    metacritic: null,
                    is_dlc: false
                });
            }
            
            const games = await Promise.allSettled(featuredAppIds.slice(0, 9).map(async (appid, index) => {
                try {
                    console.log(`${this.translate('loading_game')} ${appid}...`);
                    const gameData = await fetchSteamAppDetails(appid, cc, lang);
                    
                    if (!gameData || !gameData.name) {
                        throw new Error(this.translate('game_data_not_found'));
                    }
                    
                    console.log(`${this.translate('game_successfully_loaded')} ${appid}: ${gameData.name}`);
                    
                    const headerImage = await this.getSharedHeader(appid);
                    return {
                        appid: appid,
                        name: gameData.name,
                        header_image: headerImage,
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
                    console.warn(`${this.translate('error_loading_game')} ${appid}:`, error?.message || error);
                    return fallbackGames[index];
                }
            }));
            
            this.gamesData = games
                .filter(result => result.status === 'fulfilled' && result.value)
                .map(result => result.value);
            
            this.filteredAllGames = [...this.gamesData];
            
            if (this.gamesData.length > 0) {
                await this.renderGames();
                this.updateHeroSection();
                console.log(`${this.gamesData.length} oyun başarıyla yüklendi`);
            } else {
                throw new Error('Hiç oyun yüklenemedi');
            }
            
        } catch (error) {
            console.error('Oyunlar yüklenirken genel hata:', error);
            
            const fallbackGames2 = [];
            for (const appid of featuredAppIds.slice(0, 9)) {
                                const headerImage = await this.getSharedHeader(appid);
                fallbackGames2.push({
                    appid: appid,
                    name: `Oyun ${appid}`,
                    header_image: headerImage,
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
                });
            }
            
            this.gamesData = fallbackGames2;
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
        if (!gamesGrid) return;

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

        const fragment = document.createDocumentFragment();
        
        for (const game of this.gamesData) {
            try {
                const card = await this.createGameCard(game);
                if (card) fragment.appendChild(card);
            } catch (error) {
                console.error('Game card creation failed:', error);
            }
        }
        
        gamesGrid.replaceChildren(fragment);
    }

    async createGameCard(game, isLibrary = false) {
        if (!game || !game.appid || !game.name) {
            console.error('Invalid game object:', game);
            return null;
        }
        
        const card = document.createElement('div');
        card.className = 'game-card';
        
        if (!isLibrary) {
        card.addEventListener('click', () => this.showGameDetails(game));
        } else {
            card.style.cursor = 'default';
        }

        const imagePromise = this.getSharedHeader(game.appid);

        const tagsHtml = game.tags ? game.tags.map(tag => 
            `<span class="game-tag" style="background-color: ${tag.color}">${tag.name}</span>`
        ).join('') : '';

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

        let priceHtml = '';
        if (!isLibrary) {
            let priceText = '';
            try {
                if (!game.price || game.price === 0 || game.price === '0') {
                    priceText = this.translate('free');
                } else {
                    let symbol = '₺';
                    if (typeof game.price === 'object' && game.price.currency) {
                        const currency = game.price.currency;
                        symbol = currency === 'TRY' ? '₺' : (currency === 'USD' ? '$' : (currency === 'EUR' ? '€' : currency));
                        priceText = `${symbol}${this.formatPriceNumber(game.price.final / 100)}`;
                    } else {
                        priceText = `${symbol}${this.formatPriceNumber(game.price / 100)}`;
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

        let sourceInfo = '';

        card.innerHTML = `
                            <img src="pdbanner.png" alt="${game.name}" class="game-image" loading="lazy" style="width:100%;height:180px;object-fit:cover;border-radius:12px;box-shadow:0 2px 12px rgba(0,0,0,0.18);" data-appid="${game.appid}" data-fallback="0">
            <div class="game-info">
                <h3 class="game-title" style="font-size:18px;font-weight:700;margin-bottom:4px;">${game.name}</h3>
                ${sourceInfo}
                <div class="game-meta" style="margin-bottom:6px;">
                    ${priceHtml}
                </div>
                <div class="game-tags">${tagsHtml}</div>
                <div class="game-actions">${actionsHtml}</div>
            </div>
        `;
        
        imagePromise.then(imageUrl => {
            const img = card.querySelector('.game-image');
            if (img) {
                img.src = imageUrl;
            }
        }).catch(() => {
        });

        return card;
    }

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
                desc = desc.replace(/<[^>]+>/g, '').trim();
                if (desc.length > 200) desc = desc.slice(0, 200) + '...';
            } catch {}
            heroDescription.textContent = desc || this.translate('discovering_games');
            let priceText = '';
            if (!featuredGame.price || featuredGame.price === 0 || featuredGame.price === '0') {
                priceText = this.translate('free');
            } else {
                let symbol = '₺';
                if (typeof featuredGame.price === 'object' && featuredGame.price.currency) {
                    const currency = featuredGame.price.currency;
                    symbol = currency === 'TRY' ? '₺' : (currency === 'USD' ? '$' : (currency === 'EUR' ? '€' : currency));
                    priceText = `${symbol}${this.formatPriceNumber(featuredGame.price.final / 100)}`;
                } else {
                    priceText = `${symbol}${this.formatPriceNumber(featuredGame.price / 100)}`;
                }
            }
            if (heroPrice) heroPrice.textContent = priceText;
        if (featuredGame.appid) {
            const img = await this.getSharedHeader(featuredGame.appid);
            heroBackground.style.backgroundImage = `url(${img})`;
        }
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
        this.heroInterval = setInterval(() => {
            if (document.hidden) return; // sekme görünür değilse atla
            update();
        }, 15000);
    }

    async showGameDetails(game) {
        console.log('showGameDetails çağrıldı:', game);
        console.log('Game appid:', game.appid, 'Game name:', game.name);
        
        if (!game || !game.appid) {
            console.error('Geçersiz oyun verisi:', game);
            this.showNotification('Hata', 'Geçersiz oyun verisi', 'error');
            return;
        }
        
        this.showLoading();
        try {
            const selectedLang = this.getSelectedLang();
            console.log('Seçili dil:', selectedLang);
            
            console.log('IPC fetch-game-details çağrılıyor...');
            const gameDetails = await ipcRenderer.invoke('fetch-game-details', game.appid, selectedLang);
            console.log('IPC yanıtı alındı:', gameDetails);
            
            console.log('API yanıtı detayları:', {
                type: typeof gameDetails,
                keys: gameDetails ? Object.keys(gameDetails) : 'null',
                hasAppId: gameDetails && gameDetails.appid,
                hasName: gameDetails && gameDetails.name,
                hasSteamAppId: gameDetails && gameDetails.steam_appid,
                fullObject: gameDetails
            });
            
            let normalizedGame = null;
            
            console.log('Normalizasyon öncesi gameDetails:', {
                hasAppId: gameDetails && gameDetails.appid,
                hasName: gameDetails && gameDetails.name,
                hasSteamAppId: gameDetails && gameDetails.steam_appid,
                type: gameDetails && gameDetails.type,
                steam_appid_value: gameDetails && gameDetails.steam_appid,
                steam_appid_type: typeof (gameDetails && gameDetails.steam_appid),
                game_appid: game.appid
            });
            
            if (gameDetails && gameDetails.name) {
                const appId = gameDetails.appid || gameDetails.steam_appid || game.appid;
                
                if (appId) {
                    normalizedGame = {
                        ...gameDetails,
                        appid: String(appId), // String'e çevir
                        steam_appid: gameDetails.steam_appid || appId
                    };
                    
                    if (gameDetails.appid && gameDetails.name) {
                        console.log('Standart Steam API formatı kullanılıyor');
                    } else if (gameDetails.steam_appid && gameDetails.name) {
                        console.log('Alternatif API formatı kullanılıyor (steam_appid)');
                    } else if (gameDetails.type === 'game' && gameDetails.name) {
                        console.log('Game type formatı kullanılıyor');
                    } else {
                        console.log('Genel format kullanılıyor');
                    }
                } else {
                    console.error('AppID bulunamadı - gameDetails:', gameDetails, 'game:', game);
                }
            } else {
                console.error('Name alanı bulunamadı - gameDetails:', gameDetails);
            }
            
            console.log('Normalizasyon sonrası normalizedGame:', {
                exists: !!normalizedGame,
                appid: normalizedGame ? normalizedGame.appid : 'undefined',
                name: normalizedGame ? normalizedGame.name : 'undefined',
                steam_appid: normalizedGame ? normalizedGame.steam_appid : 'undefined'
            });
            
            if (normalizedGame && normalizedGame.appid && normalizedGame.name) {
                console.log('Oyun detayları başarıyla normalize edildi:', normalizedGame.name, 'AppID:', normalizedGame.appid);
                this.currentGameData = normalizedGame;
                
                console.log('renderGameModal çağrılıyor...');
                await this.renderGameModal(normalizedGame);
                console.log('Modal render edildi, şimdi gösteriliyor...');
                
                console.log('showModal çağrılıyor...');
                this.showModal('gameModal');
                console.log('Modal gösterildi');
            } else {
                console.error('Oyun detayları normalize edilemedi:', gameDetails);
                console.error('Normalizasyon hatası detayları:', {
                    normalizedGameExists: !!normalizedGame,
                    normalizedGameAppId: normalizedGame ? normalizedGame.appid : 'undefined',
                    normalizedGameName: normalizedGame ? normalizedGame.name : 'undefined',
                    originalGameDetails: gameDetails
                });
                
                if (game.name) {
                    console.log('Fallback olarak mevcut oyun verisi kullanılıyor...');
                    const fallbackGame = {
                        appid: game.appid,
                        name: game.name,
                        developers: [],
                        publishers: [],
                        release_date: { date: 'Bilinmiyor' },
                        price_overview: null,
                        is_free: false,
                        short_description: 'Oyun detayları yüklenemedi',
                        about_the_game: 'Oyun detayları yüklenemedi',
                        detailed_description: 'Oyun detayları yüklenemedi',
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
                    
                    this.currentGameData = fallbackGame;
                    await this.renderGameModal(fallbackGame);
                        this.showModal('gameModal');
                        
                    this.showNotification('Bilgi', `${game.name} için temel bilgiler gösteriliyor. Steam API\'den detaylar yüklenemedi.`, 'info');
                    } else {
                    this.showNotification('Hata', `${game.appid} için oyun detayları yüklenemedi. Lütfen daha sonra tekrar deneyin.`, 'error');
                }
            }
        } catch (error) {
            console.error('Failed to load game details:', error);
            console.log('Hata detayları:', {
                message: error.message,
                stack: error.stack,
                game: game
            });
            
            if (game && game.name) {
                console.log('Hata durumunda fallback kullanılıyor...');
                const errorFallbackGame = {
                    appid: game.appid,
                    name: game.name,
                    developers: [],
                    publishers: [],
                    release_date: { date: 'Bilinmiyor' },
                    price_overview: null,
                    is_free: false,
                    short_description: 'Oyun detayları yüklenirken hata oluştu',
                    about_the_game: 'Oyun detayları yüklenirken hata oluştu',
                    detailed_description: 'Oyun detayları yüklenirken hata oluştu',
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
                
                this.currentGameData = errorFallbackGame;
                await this.renderGameModal(errorFallbackGame);
                this.showModal('gameModal');
                
                this.showNotification('Bilgi', `${game.name} için temel bilgiler gösteriliyor. Hata nedeniyle detaylar yüklenemedi.`, 'info');
            } else {
            this.showNotification('Hata', 'Oyun detayları yüklenemedi', 'error');
            }
        } finally {
            this.hideLoading();
        }
    }

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
        console.log('renderGameModal çağrıldı:', game);
        const selectedLang = this.getSelectedLang();
        let cc = langToCountry[selectedLang] || selectedLang.toUpperCase() || 'TR';
        let lang = selectedLang || 'turkish';
        if (!cc || cc.length !== 2) cc = 'TR';
        if (!lang) lang = 'turkish';
        
        const aboutGameTitle = document.querySelector('[data-i18n="about_game"]');
        if (aboutGameTitle) {
            const langTitles = {
                'tr': 'Bu Oyun Hakkında',
                'en': 'About This Game',
                'de': 'Über dieses Spiel',
                'fr': 'À propos de ce jeu',
                'es': 'Acerca de este juego',
                'it': 'Informazioni su questo gioco',
                'ru': 'Об этой игре'
            };
            aboutGameTitle.textContent = langTitles[selectedLang] || langTitles['en'];
        }
        const modal = document.getElementById('gameModal');
        const mainImage = document.getElementById('modalMainImage');
        const videoContainer = document.getElementById('modalVideoContainer');
        const previewThumbnails = document.getElementById('modalPreviewThumbnails');
        let videoEl = null;
        let media = [];
        let hasVideo = game.movies && game.movies.length > 0 && game.movies[0].mp4;
        if (hasVideo) {
            media.push({ type: 'video', src: game.movies[0].mp4.max || game.movies[0].mp4[480] || '', thumb: game.movies[0].thumbnail || '', title: 'Video' });
        }
        const headerImage = await this.getSharedHeader(game.appid);
        media.push({ type: 'image', src: headerImage, thumb: headerImage, title: 'Kapak' });
        let screenshots = Array.isArray(game.screenshots) ? game.screenshots : [];
        screenshots.forEach((s, i) => {
            media.push({ type: 'image', src: s.path_full || s, thumb: s.path_thumbnail || s.path_full || s, title: `Ekran Görüntüsü ${i+1}` });
        });
        let activeIndex = 0;
        const config = this.config;
        const renderGallery = (idx) => {
            activeIndex = idx;
            videoContainer.innerHTML = '';
            mainImage.style.display = 'none';
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
        modal.onkeydown = (e) => {
            if (e.key === 'ArrowLeft') {
                renderGallery((activeIndex - 1 + media.length) % media.length);
            } else if (e.key === 'ArrowRight') {
                renderGallery((activeIndex + 1) % media.length);
            }
        };
        setTimeout(() => { modal.focus && modal.focus(); }, 200);
        renderGallery(0);
        const modalTitle = document.getElementById('modalTitle');
        const modalDeveloper = document.getElementById('modalDeveloper');
        const modalReleaseDate = document.getElementById('modalReleaseDate');
        
        if (modalTitle) modalTitle.textContent = game.name || 'Oyun Adı';
        if (modalDeveloper) modalDeveloper.textContent = game.developers ? game.developers.join(', ') : 'Bilinmiyor';
        if (modalReleaseDate) modalReleaseDate.textContent = game.release_date ? game.release_date.date : 'Bilinmiyor';
        
        const modalPrice = document.getElementById('modalPrice');
        const modalReviews = document.getElementById('modalReviews');
        
        if (modalPrice) {
            if (game.price_overview && game.price_overview.final_formatted) {
                modalPrice.textContent = game.price_overview.final_formatted;
            } else if (game.is_free) {
                modalPrice.textContent = 'Ücretsiz';
            } else {
                modalPrice.textContent = 'Fiyat bilgisi yok';
            }
        }
        
        if (modalReviews) {
            if (game.recommendations && game.recommendations.total) {
                const total = game.recommendations.total;
                if (total > 1000) {
                    modalReviews.textContent = 'Çok Olumlu';
                } else if (total > 500) {
                    modalReviews.textContent = 'Olumlu';
                } else {
                    modalReviews.textContent = 'Karışık';
                }
            } else {
                modalReviews.textContent = 'İnceleme yok';
            }
        }
        let descFound = false;
        let desc = '';
        const descEl = document.getElementById('modalDescription');
        if (descEl) descEl.classList.add('modal-description');
        try {
            console.log(`🌐 Oyun açıklaması yükleniyor: ${game.appid}, Dil: ${lang}, Ülke: ${cc}`);
            
            const url = `https://store.steampowered.com/api/appdetails?appids=${game.appid}&cc=${cc}&l=${lang}`;
            const resLang = await safeSteamFetch(url);
            let descGameData;
            
            if (resLang.ok) {
                const dataLang = await resLang.json();
                descGameData = dataLang[game.appid]?.data;
                console.log(`✅ Seçili dilde açıklama bulundu: ${lang}`);
            } else if (resLang.status === 403 && cc !== 'TR') {
                console.log(`🔄 403 hatası, Türkçe'de deneniyor...`);
                const fallbackRes = await safeSteamFetch(`https://store.steampowered.com/api/appdetails?appids=${game.appid}&cc=TR&l=turkish`);
                if (fallbackRes.ok) {
                    const dataLang = await fallbackRes.json();
                    descGameData = dataLang[game.appid]?.data;
                    console.log(`✅ Türkçe'de açıklama bulundu`);
                }
            }
            
            if (descGameData) {
                desc = descGameData.about_the_game || descGameData.detailed_description || descGameData.short_description || '';
                desc = desc.trim().replace(/^<br\s*\/?>|<br\s*\/?>$/gi, '');
                
                if (desc) {
                    console.log(`📝 Açıklama yüklendi, uzunluk: ${desc.length} karakter`);
                    if (/<[a-z][\s\S]*>/i.test(desc)) {
                        descEl.innerHTML = desc;
                    } else {
                        descEl.textContent = desc;
                    }
                    descFound = true;
                }
            }
            
            if (!descFound) {
                const fallbackLanguages = ['english', 'turkish', 'german', 'french', 'spanish', 'italian', 'russian'];
                for (const fallbackLang of fallbackLanguages) {
                    if (fallbackLang === lang) continue; // Zaten denenmiş
                    
                    try {
                        console.log(`🔄 ${fallbackLang} dilinde deneniyor...`);
                        const fallbackUrl = `https://store.steampowered.com/api/appdetails?appids=${game.appid}&cc=${cc}&l=${fallbackLang}`;
                        const fallbackRes = await safeSteamFetch(fallbackUrl);
                        
                        if (fallbackRes.ok) {
                            const fallbackData = await fallbackRes.json();
                            const fallbackDescData = fallbackData[game.appid]?.data;
                            
                            if (fallbackDescData) {
                                const fallbackDesc = fallbackDescData.about_the_game || fallbackDescData.detailed_description || fallbackDescData.short_description || '';
                                if (fallbackDesc && fallbackDesc.trim()) {
                                    console.log(`✅ ${fallbackLang} dilinde açıklama bulundu, çevriliyor...`);
                                    
                                    const translateRes = await safeSteamFetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${fallbackLang}&tl=${lang}&dt=t&q=${encodeURIComponent(fallbackDesc)}`);
                                    const translateData = await translateRes.json();
                                    const translated = translateData[0]?.map(part => part[0]).join(' ');
                                    
                                    if (translated && translated.trim()) {
                                        desc = translated.trim();
                                        if (/<[a-z][\s\S]*>/i.test(desc)) {
                                            descEl.innerHTML = desc;
                                        } else {
                                            descEl.textContent = desc;
                                        }
                                        descFound = true;
                                        console.log(`✅ Açıklama ${fallbackLang} dilinden ${lang} diline çevrildi`);
                                        break;
                                    }
                                }
                            }
                        }
                    } catch (error) {
                        console.log(`❌ ${fallbackLang} dilinde deneme başarısız:`, error.message);
                    }
                }
            }
        } catch (error) {
            console.error(`❌ Oyun açıklaması yüklenirken hata:`, error);
        }
        if (!descFound) {
            console.log(`🔄 Fallback açıklama deneniyor...`);
            let fallbackDesc = '';
            
            if (game.short_description && game.short_description.trim()) {
                fallbackDesc = game.short_description.trim();
                console.log(`📝 Short description bulundu`);
            } else if (game.about_the_game && game.about_the_game.trim()) {
                fallbackDesc = game.about_the_game.trim();
                console.log(`📝 About the game bulundu`);
            } else if (game.detailed_description && game.detailed_description.trim()) {
                fallbackDesc = game.detailed_description.trim();
                console.log(`📝 Detailed description bulundu`);
            }
            
            if (fallbackDesc) {
                console.log(`📝 Fallback açıklama bulundu, çeviriliyor...`);
                try {
                    const sl = 'en'; // varsayılan kaynak dil
                    const tl = selectedLang;
                    const translateRes = await safeSteamFetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(fallbackDesc)}`);
                    const translateData = await translateRes.json();
                    const translated = translateData[0]?.map(part => part[0]).join(' ');
                    
                    if (translated && translated.trim()) {
                        console.log(`✅ Açıklama çevrildi: ${lang}`);
                        if (/<[a-z][\s\S]*>/i.test(translated)) {
                            descEl.innerHTML = translated;
                        } else {
                            descEl.textContent = translated;
                        }
                        descFound = true;
                    } else {
                        throw new Error('Çeviri sonucu boş');
                    }
                } catch (translateError) {
                    console.error(`❌ Çeviri hatası:`, translateError);
                    if (/<[a-z][\s\S]*>/i.test(fallbackDesc)) {
                        descEl.innerHTML = fallbackDesc;
                    } else {
                        descEl.textContent = fallbackDesc;
                    }
                    descFound = true;
                }
            } else {
                console.log(`❌ Hiçbir açıklama bulunamadı`);
                descEl.textContent = this.translate('no_description');
            }
        }
        const dev = game.developers ? game.developers.join(', ') : 'Bilinmiyor';
        const pub = game.publishers ? game.publishers.join(', ') : 'Bilinmiyor';
        const release = game.release_date ? game.release_date.date : 'Bilinmiyor';
        const modalDevDetail = document.getElementById('modalDevDetail');
        if (modalDevDetail) modalDevDetail.textContent = dev;
        const modalPublisher = document.getElementById('modalPublisher');
        if (modalPublisher) modalPublisher.textContent = pub;
        const modalRelease = document.getElementById('modalRelease');
        if (modalRelease) modalRelease.textContent = release;
        const reviewsContainer = document.getElementById('modalReviews');
        let reviewText = game.reviews || '';
        if (reviewText) {
            console.log(`📝 Review çeviriliyor: ${reviewText.substring(0, 50)}...`);
            try {
                const sl = 'en'; // varsayılan kaynak dil
                const tl = selectedLang;
                const translateRes = await safeSteamFetch(`https://translate.googleapis.com/translate_a/single?client=gtx&sl=${sl}&tl=${tl}&dt=t&q=${encodeURIComponent(reviewText)}`);
                const translateData = await translateRes.json();
                const translated = translateData[0]?.map(part => part[0]).join(' ');
                
                if (translated && translated.trim()) {
                    console.log(`✅ Review çevrildi: ${lang}`);
                    reviewsContainer.textContent = translated;
                } else {
                    reviewsContainer.textContent = reviewText;
                }
            } catch (error) {
                console.error(`❌ Review çeviri hatası:`, error);
                reviewsContainer.textContent = reviewText;
            }
        } else {
            reviewsContainer.textContent = '';
        }
        const ratingEl = document.getElementById('modalRating');
        if (ratingEl && ratingEl.parentElement) {
            ratingEl.parentElement.style.display = 'none';
        }
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
        const addBtn = document.getElementById('modalAddBtn');
        const steamBtn = document.getElementById('modalSteamBtn');
        const startBtn = document.getElementById('modalStartBtn');
        const isInLibrary = this.libraryGames && this.libraryGames.some(libGame => libGame.appid == game.appid);
        if (addBtn) {
            addBtn.style.display = isInLibrary ? 'none' : '';
            addBtn.textContent = this.translate('add_to_library');
            addBtn.disabled = isInLibrary;
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
        const priceEl = document.getElementById('modalPrice');
        if (priceEl) {
            let priceText = '';
            if (!game.price || game.price === 0 || game.price === '0') {
                priceText = this.translate('free');
            } else if (typeof game.price === 'object' && game.price.final) {
                let currency = game.price.currency || 'TRY';
                let symbol = currency === 'TRY' ? '₺' : (currency === 'USD' ? '$' : (currency === 'EUR' ? '€' : currency));
                priceText = `${symbol}${(game.price.final / 100).toFixed(2)}`;
            } else if (!isNaN(game.price)) {
                let symbol = '₺';
                priceText = `${symbol}${(game.price / 100).toFixed(2)}`;
            } else {
                priceText = this.translate('free');
            }
            priceEl.textContent = priceText;
        }
        
        console.log('renderGameModal tamamlandı, modal hazır');
    }

    async addGameToLibrary(appId) {
        console.log('addGameToLibrary çağrıldı, appId:', appId);
        console.log('Mevcut config:', this.config);
        
        this.showLoading();
        
        if (!this.config.steamPath || this.config.steamPath === '' || this.config.steamPath === null) {
            console.error('Steam path bulunamadı!');
            
            const shouldSelectPath = confirm('Steam yolu bulunamadı! Steam yolu seçmek ister misiniz?');
            if (shouldSelectPath) {
                await this.selectSteamPath();
                if (this.config.steamPath && this.config.steamPath !== '' && this.config.steamPath !== null) {
                    console.log('Steam yolu seçildi, tekrar deneniyor...');
                    return await this.addGameToLibrary(appId);
                }
            }
            
            this.hideLoading(); // Yükleme ekranını kapat
            this.showNotification('error', 'steam_path_failed', 'error');
            return;
        }
        
        console.log('Steam path bulundu:', this.config.steamPath);
        
        
        console.log('Oyun detayları alınıyor...');
        const gameDetails = await ipcRenderer.invoke('fetch-game-details', appId, this.getSelectedLang());
        console.log('Oyun detayları:', gameDetails);
        console.log('Oyun detayları tipi:', typeof gameDetails);
        console.log('Oyun detayları null mu?', gameDetails === null);
        console.log('Oyun detayları undefined mu?', gameDetails === undefined);
        console.log('Oyun detayları appid var mı?', gameDetails && gameDetails.appid);
        
        if (!gameDetails || (!gameDetails.appid && !gameDetails.steam_appid)) {
            console.error('Oyun detayları alınamadı');
            console.error('gameDetails değeri:', gameDetails);
            this.hideLoading(); // Yükleme ekranını kapat
            this.showNotification('error', 'Oyun bulunamadı', 'error');
            return;
        }
        
        if (!gameDetails.appid && gameDetails.steam_appid) {
            gameDetails.appid = gameDetails.steam_appid;
        }
        
        if (gameDetails && gameDetails.dlc && gameDetails.dlc.length > 0) {
            console.log('DLC bulundu, DLC seçim ekranı açılıyor...');
            this.hideLoading(); // DLC seçim ekranı açılmadan önce loading'i kapat
            this.showDLCSelection(gameDetails, appId);
            return;
        }
        
        console.log('DLC yok, oyun ekleniyor...');
        try {
            console.log('IPC add-game-to-library çağrılıyor...');
            const result = await ipcRenderer.invoke('add-game-to-library', appId, []);
            console.log('IPC sonucu:', result);
            
            if (result.success) {
                console.log('Oyun başarıyla eklendi!');
                this.showNotification('success', this.translate('game_added_success'), 'success');
                this.closeModal('gameModal');
                this.showSteamRestartDialog();
                
                setTimeout(() => {
                    this.loadLibrary();
                }, 1000);
            } else {
                console.error('Oyun eklenemedi, result:', result);
                
                if (result.message === 'GAME_NOT_FOUND') {
                    this.showNotification('error', this.translate('game_not_found'), 'error');
                } else {
                    this.showNotification('error', this.translate('game_add_failed'), 'error');
                }
            }
        } catch (error) {
            console.error('Oyun ekleme hatası:', error);
            
            this.showNotification('error', this.translate('game_not_found'), 'error');
        } finally {
            this.hideLoading();
        }
    }

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
            this.showNotification('Başarılı', this.translate('steam_restarting'), 'success');
            this.closeModal('steamRestartModal');
        } catch (error) {
            console.error('Failed to restart Steam:', error);
            this.showNotification('Hata', this.translate('steam_restart_failed'), 'error');
        }
    }

    async loadLibrary() {
        try {
            console.log('🔄 Kütüphane yükleniyor...');
            
                this.libraryGames = [];
            
            const rawGames = await ipcRenderer.invoke('get-library-games');
            
            if (Array.isArray(rawGames)) {
                this.libraryGames = rawGames;
            }
            
            console.log(`📚 Kütüphanede ${this.libraryGames.length} oyun bulundu`);
            await this.renderLibrary();
        } catch (error) {
            console.error('Failed to load library:', error);
            this.libraryGames = [];
            await this.renderLibrary();
            this.showNotification('Hata', this.translate('library_load_failed'), 'error');
        }
    }

    async refreshLibrary() {
        const refreshBtn = document.getElementById('refreshLibraryBtn');
        if (refreshBtn) {
            refreshBtn.classList.add('loading');
        }
        
        try {
            this.showNotification('info', this.translate('refreshing_library'), 'info');
            
            this.libraryGames = [];
            
            const rawGames = await ipcRenderer.invoke('get-library-games');
            
            if (Array.isArray(rawGames)) {
                this.libraryGames = rawGames;
            }
            
            await this.renderLibrary();
            this.showNotification('success', this.translate('library_refreshed'), 'success');
        } catch (error) {
            console.error('Failed to refresh library:', error);
            this.showNotification('error', this.translate('library_refresh_failed'), 'error');
        } finally {
            if (refreshBtn) {
                refreshBtn.classList.remove('loading');
            }
        }
    }

    async renderLibrary() {
        const libraryGrid = document.getElementById('libraryGrid');
        const libraryCount = document.getElementById('libraryCount');
        
        libraryCount.textContent = `${this.libraryGames.length} ${this.translate('games_found_in_library')}`;
        libraryGrid.innerHTML = '';

        if (this.libraryGames.length === 0) {
            libraryGrid.innerHTML = '<div class="no-games">Kütüphanenizde henüz oyun yok</div>';
            return;
        }

        const gameCardPromises = this.libraryGames.map(game => this.createGameCard(game, true));
        const gameCards = await Promise.all(gameCardPromises);
        
        gameCards.forEach(card => {
            if (card) {
                libraryGrid.appendChild(card);
            }
        });
    }

    openSteamPage(appId) {
        ipcRenderer.invoke('open-external', `https://store.steampowered.com/app/${appId}`);
    }



    async loadMoreAllGames() {
        const cc = this.countryCode || 'TR';
        const lang = this.getSelectedLang();
        this.showLoading();
        try {
            const offset = this.gamesData.length;
            const resultsUrl = `https://store.steampowered.com/search/results?sort_by=Reviews_DESC&category1=998&force_infinite=1&start=${offset}&count=20&supportedlang=turkish&ndl=1&snr=1_7_7_151_7`;
            const html = await (await safeSteamFetch(resultsUrl)).text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const rows = doc.querySelectorAll('.search_result_row');
            const newGamesRaw = Array.from(rows).map(row => {
                const appid = row.getAttribute('data-ds-appid');
                const name = row.querySelector('.title')?.textContent?.trim() || '';
                return { appid, name };
            });
            const existingAppIds = new Set(this.gamesData.map(g => String(g.appid)));
            const filteredGames = newGamesRaw.filter(g => !existingAppIds.has(String(g.appid)));
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
            this.showNotification('Hata', this.translate('games_load_failed'), 'error');
        } finally {
            this.hideLoading();
        }
    }

    showModal(modalId) {
        console.log('showModal çağrıldı:', modalId);
        const modal = document.getElementById(modalId);
        console.log('Modal element:', modal);
        
        if (modal) {
            console.log('Modal bulundu, gösteriliyor...');
            console.log('Modal önceki display:', modal.style.display);
            console.log('Modal önceki classList:', modal.classList.toString());
            
            modal.style.display = 'flex';
        modal.classList.add('active');
        document.body.style.overflow = 'hidden';
            
            console.log('Modal gösterildi, display:', modal.style.display, 'classList:', modal.classList.toString());
            console.log('Modal offsetWidth:', modal.offsetWidth, 'offsetHeight:', modal.offsetHeight);
            console.log('Modal getBoundingClientRect:', modal.getBoundingClientRect());
        } else {
            console.error('Modal bulunamadı:', modalId);
            console.log('Mevcut modal elementleri:');
            document.querySelectorAll('.modal-overlay').forEach((m, i) => {
                console.log(`Modal ${i}:`, m.id, m.className);
            });
        }
    }

    closeModal(modalId) {
        const modal = document.getElementById(modalId);
        if (modal) {
        modal.classList.remove('active');
            modal.style.display = 'none';
        document.body.style.overflow = 'auto';
        
        if (modalId === 'steamRestartModal' && this.restartCountdown) {
            clearInterval(this.restartCountdown);
        }
        if (modalId === 'gameModal') {
            this.clearGameModalState();
            }
        }
    }

    closeAllModals() {
        document.querySelectorAll('.modal-overlay').forEach(modal => {
            modal.classList.remove('active');
            modal.style.display = 'none';
        });
        document.body.style.overflow = 'auto';
        
        if (this.restartCountdown) {
            clearInterval(this.restartCountdown);
        }
    }

    showLoading(customMessage = null) {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.classList.add('active');
            overlay.style.display = 'flex';
            
            this.applyLoadingScreenCustomization();
        }
        const loadingText = document.querySelector('.loading-text');
        if (loadingText) {
            loadingText.textContent = customMessage || this.translate('loading_games');
        }
    }

    hideLoading() {
        const overlay = document.getElementById('loadingOverlay');
        if (overlay) {
            overlay.classList.remove('active');
            overlay.style.display = 'none';
        }
    }

    setupNotificationSettings() {
        this.setupMinimalSettings();
        
        this.setupAdvancedSettingsButton();
        
        this.setupPreviewButtons();
        
        this.setupSettingsManagement();
        
        this.setupNotificationSettingsSave();
        
        this.setupTestButtons();
        
        this.setupSettingsManagementButtons();
        
        this.setupAdvancedDurationSlider();
        
        this.setupNewNotificationSettings();
        
        this.setupCompactNotificationSettings();
        
        this.applyNotificationTheme();
        this.applyNotificationPosition();
    }

    setupMinimalSettings() {
        const themeSelect = document.getElementById('notificationThemeSelect');
        if (themeSelect) {
            themeSelect.value = this.config.notificationTheme || 'default';
            themeSelect.addEventListener('change', (e) => {
                this.updateConfig({ notificationTheme: e.target.value });
                this.applyNotificationTheme();
            });
        }

        const positionSelect = document.getElementById('notificationPositionSelect');
        if (positionSelect) {
            positionSelect.value = this.config.notificationPosition || 'top-right';
            positionSelect.addEventListener('change', (e) => {
                this.updateConfig({ notificationPosition: e.target.value });
                this.applyNotificationPosition();
            });
        }

        const durationSlider = document.getElementById('notificationDurationSlider');
        const durationValue = document.getElementById('notificationDurationValue');
        if (durationSlider && durationValue) {
            const currentDuration = this.config.notificationDuration || 3;
            durationSlider.value = currentDuration;
            durationValue.textContent = currentDuration;
            
            durationSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                durationValue.textContent = value;
                this.updateConfig({ notificationDuration: parseInt(value) });
            });
        }

        const animationSelect = document.getElementById('notificationAnimationSelect');
        if (animationSelect) {
            animationSelect.value = this.config.notificationAnimation || 'slide';
            animationSelect.addEventListener('change', (e) => {
                this.updateConfig({ notificationAnimation: e.target.value });
            });
        }

        const soundVolumeSlider = document.getElementById('soundVolumeSlider');
        const soundVolumeValue = document.getElementById('soundVolumeValue');
        if (soundVolumeSlider && soundVolumeValue) {
            const currentVolume = this.config.notificationVolume || 100;
            soundVolumeSlider.value = currentVolume;
            soundVolumeValue.textContent = currentVolume + '%';
            
            soundVolumeSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                soundVolumeValue.textContent = value + '%';
                this.updateConfig({ notificationVolume: parseInt(value) });
                
                const advancedSlider = document.getElementById('advancedSoundVolumeSlider');
                const advancedValue = document.getElementById('advancedSoundVolumeValue');
                if (advancedSlider && advancedValue) {
                    advancedSlider.value = value;
                    advancedValue.textContent = value + '%';
                }
            });
        }
    }

    setupAdvancedSettingsButton() {
        const advancedBtn = document.getElementById('advancedNotificationBtn');
        if (advancedBtn) {
            advancedBtn.addEventListener('click', () => {
                this.showAdvancedNotificationSettings();
            });
        }
    }

    showAdvancedNotificationSettings() {
        const modal = document.getElementById('advancedNotificationModal');
        if (modal) {
            modal.classList.add('active');
            this.setupAdvancedSettings();
        }
    }

    setupAdvancedSettings() {
        this.setupAdvancedThemeSelector();
        
        this.setupAdvancedPositionSelector();
        
        this.setupAdvancedAnimationSelector();
        
        this.setupAdvancedSoundSettings();
        
        this.setupAdvancedColorPickers();
    }

    setupThemeSelector() {
        const themeOptions = document.querySelectorAll('.theme-option');
        const currentTheme = this.config.notificationTheme || 'default';
        
        themeOptions.forEach(option => {
            const theme = option.dataset.theme;
            if (theme === currentTheme) {
                option.classList.add('active');
            }
            
            option.addEventListener('click', () => {
                themeOptions.forEach(opt => opt.classList.remove('active'));
                option.classList.add('active');
                
                this.updateConfig({ notificationTheme: theme });
                this.applyNotificationTheme();
            });
        });
    }

    setupPositionSelector() {
        const positionOptions = document.querySelectorAll('.position-option');
        const currentPosition = this.config.notificationPosition || 'top-right';
        
        positionOptions.forEach(option => {
            const position = option.dataset.position;
            if (position === currentPosition) {
                option.classList.add('active');
            }
            
            option.addEventListener('click', () => {
                positionOptions.forEach(opt => opt.classList.remove('active'));
                option.classList.add('active');
                
                this.updateConfig({ notificationPosition: position });
                this.applyNotificationPosition();
            });
        });
    }

    setupDurationSlider() {
        const durationSlider = document.getElementById('notificationDurationSlider');
        const durationValue = document.getElementById('notificationDurationValue');
        
        if (durationSlider && durationValue) {
            const currentDuration = this.config.notificationDuration || 3;
            durationSlider.value = currentDuration;
            durationValue.textContent = currentDuration;
            
            durationSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                durationValue.textContent = value;
                this.updateConfig({ notificationDuration: parseInt(value) });
            });
        }
    }

    setupAnimationSelector() {
        const animationOptions = document.querySelectorAll('.animation-option');
        const currentAnimation = this.config.notificationAnimation || 'slide';
        
        animationOptions.forEach(option => {
            const animation = option.dataset.animation;
            if (animation === currentAnimation) {
                option.classList.add('active');
            }
            
            option.addEventListener('click', () => {
                animationOptions.forEach(opt => opt.classList.remove('active'));
                option.classList.add('active');
                
                this.updateConfig({ notificationAnimation: animation });
            });
        });
    }

    setupSoundSettings() {
        const soundToggle = document.getElementById('notificationSoundToggle');
        const soundVolumeContainer = document.getElementById('soundVolumeContainer');
        const soundVolumeSlider = document.getElementById('soundVolumeSlider');
        const soundVolumeValue = document.getElementById('soundVolumeValue');
        
        if (soundToggle) {
            const currentSound = this.config.notificationSound || false;
            soundToggle.checked = currentSound;
            
            if (soundVolumeContainer) {
                soundVolumeContainer.style.display = currentSound ? 'flex' : 'none';
            }
            
            soundToggle.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                this.updateConfig({ notificationSound: enabled });
                
                if (soundVolumeContainer) {
                    soundVolumeContainer.style.display = enabled ? 'flex' : 'none';
                }
            });
        }
        
        if (soundVolumeSlider && soundVolumeValue) {
            const currentVolume = this.config.notificationVolume || 100;
            soundVolumeSlider.value = currentVolume;
            soundVolumeValue.textContent = currentVolume + '%';
            
            soundVolumeSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                soundVolumeValue.textContent = value + '%';
                this.updateConfig({ notificationVolume: parseInt(value) });
            });
        }
    }

    setupColorPickers() {
        const colorPickers = {
            success: document.getElementById('successColorPicker'),
            error: document.getElementById('errorColorPicker'),
            warning: document.getElementById('warningColorPicker'),
            info: document.getElementById('infoColorPicker')
        };
        
        const currentColors = this.config.notificationColors || {
            success: '#22c55e',
            error: '#ef4444',
            warning: '#f59e0b',
            info: '#00d4ff'
        };
        
        Object.keys(colorPickers).forEach(type => {
            const picker = colorPickers[type];
            if (picker) {
                picker.value = currentColors[type];
                
                picker.addEventListener('change', (e) => {
                    const newColors = { ...currentColors, [type]: e.target.value };
                    this.updateConfig({ notificationColors: newColors });
                });
            }
        });
    }

    setupPreviewButtons() {
        const previewSuccessBtn = document.getElementById('previewSuccessBtn');
        const previewErrorBtn = document.getElementById('previewErrorBtn');
        const previewWarningBtn = document.getElementById('previewWarningBtn');
        const previewInfoBtn = document.getElementById('previewInfoBtn');

        if (previewSuccessBtn) previewSuccessBtn.addEventListener('click', () => this.showNotification('success', 'Bu bir başarı bildirimi önizlemesidir', 'success'));
        if (previewErrorBtn) previewErrorBtn.addEventListener('click', () => this.showNotification('error', 'Bu bir hata bildirimi önizlemesidir', 'error'));
        if (previewWarningBtn) previewWarningBtn.addEventListener('click', () => this.showNotification('warning', 'Bu bir uyarı bildirimi önizlemesidir', 'warning'));
        if (previewInfoBtn) previewInfoBtn.addEventListener('click', () => this.showNotification('info', 'Bu bir bilgi bildirimi önizlemesidir', 'info'));
    }

    setupAdvancedThemeSelector() {
        const themeOptions = document.querySelectorAll('#advancedNotificationModal .theme-option-compact');
        const currentTheme = this.config.notificationTheme || 'default';
        
        themeOptions.forEach(option => {
            const theme = option.dataset.theme;
            if (theme === currentTheme) {
                option.classList.add('active');
            }
            
            option.addEventListener('click', () => {
                themeOptions.forEach(opt => opt.classList.remove('active'));
                option.classList.add('active');
                
                this.updateConfig({ notificationTheme: theme });
                this.applyNotificationTheme();
                
                const minimalSelect = document.getElementById('notificationThemeSelect');
                if (minimalSelect) minimalSelect.value = theme;
            });
        });
    }

    setupAdvancedPositionSelector() {
        const positionOptions = document.querySelectorAll('#advancedNotificationModal .position-option-compact');
        const currentPosition = this.config.notificationPosition || 'top-right';
        
        positionOptions.forEach(option => {
            const position = option.dataset.position;
            if (position === currentPosition) {
                option.classList.add('active');
            }
            
            option.addEventListener('click', () => {
                positionOptions.forEach(opt => opt.classList.remove('active'));
                option.classList.add('active');
                
                this.updateConfig({ notificationPosition: position });
                this.applyNotificationPosition();
                
                const minimalSelect = document.getElementById('notificationPositionSelect');
                if (minimalSelect) minimalSelect.value = position;
            });
        });
    }

    setupAdvancedAnimationSelector() {
        const animationOptions = document.querySelectorAll('#advancedNotificationModal .animation-option-compact');
        const currentAnimation = this.config.notificationAnimation || 'slide';
        
        animationOptions.forEach(option => {
            const animation = option.dataset.animation;
            if (animation === currentAnimation) {
                option.classList.add('active');
            }
            
            option.addEventListener('click', () => {
                animationOptions.forEach(opt => opt.classList.remove('active'));
                option.classList.add('active');
                
                this.updateConfig({ notificationAnimation: animation });
                
                const minimalSelect = document.getElementById('notificationAnimationSelect');
                if (minimalSelect) minimalSelect.value = animation;
            });
        });
    }

    setupAdvancedSoundSettings() {
        const soundToggle = document.getElementById('advancedNotificationSoundToggle');
        const soundVolumeContainer = document.getElementById('advancedSoundVolumeContainer');
        const soundVolumeSlider = document.getElementById('advancedSoundVolumeSlider');
        const soundVolumeValue = document.getElementById('advancedSoundVolumeValue');
        const soundFileContainer = document.getElementById('soundFileContainer');
        const selectSoundBtn = document.getElementById('selectSoundFileBtn');
        const soundFileInput = document.getElementById('soundFileInput');
        const selectedSoundFileName = document.getElementById('selectedSoundFileName');
        
        if (soundToggle) {
            const currentSound = this.config.notificationSound || false;
            soundToggle.checked = currentSound;
            
            if (soundVolumeContainer) {
                soundVolumeContainer.style.display = currentSound ? 'flex' : 'none';
            }
            
            if (soundFileContainer) {
                soundFileContainer.style.display = currentSound ? 'flex' : 'none';
            }
            
            soundToggle.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                this.updateConfig({ notificationSound: enabled });
                
                if (soundVolumeContainer) {
                    soundVolumeContainer.style.display = enabled ? 'flex' : 'none';
                }
                
                if (soundFileContainer) {
                    soundFileContainer.style.display = enabled ? 'flex' : 'none';
                }
                
                if (enabled) {
                    this.playNotificationSound('info');
                }
            });
        }
        
        if (soundVolumeSlider && soundVolumeValue) {
            const currentVolume = this.config.notificationVolume || 100;
            soundVolumeSlider.value = currentVolume;
            soundVolumeValue.textContent = currentVolume + '%';
            
            soundVolumeSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                soundVolumeValue.textContent = value + '%';
                this.updateConfig({ notificationVolume: parseInt(value) });
            });
        }

        if (selectSoundBtn && selectedSoundFileName) {
            const currentSoundFile = this.config.notificationSoundFile || null;
            if (currentSoundFile && currentSoundFile.name) {
                selectedSoundFileName.textContent = currentSoundFile.name;
            }
            
            selectSoundBtn.addEventListener('click', () => {
                this.selectSoundFile();
            });
        }
    }

    setupAdvancedColorPickers() {
        const colorPickers = {
            success: document.getElementById('advancedSuccessColorPicker'),
            error: document.getElementById('advancedErrorColorPicker'),
            warning: document.getElementById('advancedWarningColorPicker'),
            info: document.getElementById('advancedInfoColorPicker')
        };
        
        const currentColors = this.config.notificationColors || {
            success: '#22c55e',
            error: '#ef4444',
            warning: '#f59e0b',
            info: '#00d4ff'
        };
        
        Object.keys(colorPickers).forEach(type => {
            const picker = colorPickers[type];
            if (picker) {
                picker.value = currentColors[type];
                
                picker.addEventListener('change', (e) => {
                    const newColors = { ...currentColors, [type]: e.target.value };
                    this.updateConfig({ notificationColors: newColors });
                });
            }
        });
    }

    setupNotificationSettingsSave() {
        const saveBtn = document.getElementById('saveNotificationSettingsBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                this.saveNotificationSettings();
            });
        }
    }

    setupTestButtons() {
        const testSoundBtn = document.getElementById('testSoundBtn');
        const testNotificationBtn = document.getElementById('testNotificationBtn');
        
        if (testSoundBtn) {
            testSoundBtn.addEventListener('click', () => {
                this.testCustomSound();
            });
        }
        
        if (testNotificationBtn) {
            testNotificationBtn.addEventListener('click', () => {
                this.testNotification('success', 'Bu bir test bildirimidir!', 'success');
            });
        }
    }

    setupSettingsManagementButtons() {
        const resetBtn = document.getElementById('resetNotificationSettingsBtn');
        const exportBtn = document.getElementById('exportNotificationSettingsBtn');
        const importBtn = document.getElementById('importNotificationSettingsBtn');
        const importFile = document.getElementById('importNotificationSettingsFile');
        
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this.resetNotificationSettings();
            });
        }
        
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                this.exportNotificationSettings();
            });
        }
        
        if (importBtn) {
            importBtn.addEventListener('click', () => {
                importFile.click();
            });
        }
        
        if (importFile) {
            importFile.addEventListener('change', (event) => {
                const file = event.target.files[0];
                if (file) {
                    this.importNotificationSettings(file);
                }
            });
        }
    }

    setupSettingsManagement() {
        const resetBtn = document.getElementById('resetSettingsBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this.resetSettingsToDefault();
            });
        }

        const exportBtn = document.getElementById('exportSettingsBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                this.exportSettings();
            });
        }

        const importBtn = document.getElementById('importSettingsBtn');
        const importFile = document.getElementById('importSettingsFile');
        if (importBtn && importFile) {
            importBtn.addEventListener('click', () => {
                importFile.click();
            });
            
            importFile.addEventListener('change', (e) => {
                this.importSettings(e.target.files[0]);
            });
        }
    }

    resetSettingsToDefault() {
        if (confirm('Tüm ayarları varsayılana almak istediğinizden emin misiniz?')) {
            const defaultConfig = {
                notificationTheme: 'default',
                notificationPosition: 'top-right',
                notificationDuration: 3,
                notificationAnimation: 'slide',
                notificationVolume: 50,
                notificationColors: {
                    success: '#22c55e',
                    error: '#ef4444',
                    warning: '#f59e0b',
                    info: '#00d4ff'
                }
            };
            
            this.updateConfig(defaultConfig);
            this.showNotification('success', 'Ayarlar varsayılana alındı', 'success');
            
            setTimeout(() => {
                this.setupNotificationSettings();
            }, 100);
        }
    }

    exportSettings() {
        try {
            const settingsData = {
                notificationTheme: this.config.notificationTheme || 'default',
                notificationPosition: this.config.notificationPosition || 'top-right',
                notificationDuration: this.config.notificationDuration || 3,
                notificationAnimation: this.config.notificationAnimation || 'slide',
                notificationVolume: this.config.notificationVolume || 100,
                notificationColors: this.config.notificationColors || {
                    success: '#22c55e',
                    error: '#ef4444',
                    warning: '#f59e0b',
                    info: '#00d4ff'
                }
            };
            
            const dataStr = JSON.stringify(settingsData, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            
            const link = document.createElement('a');
            link.href = URL.createObjectURL(dataBlob);
            link.download = 'paradise-notification-settings.json';
            link.click();
            
            this.showNotification('success', 'Ayarlar dışa aktarıldı', 'success');
        } catch (error) {
            console.error('Export error:', error);
            this.showNotification('error', 'Ayarlar dışa aktarılamadı', 'error');
        }
    }

    async importSettings(file) {
        try {
            const text = await file.text();
            const settingsData = JSON.parse(text);
            
            const validSettings = {
                notificationTheme: settingsData.notificationTheme || 'default',
                notificationPosition: settingsData.notificationPosition || 'top-right',
                notificationDuration: settingsData.notificationDuration || 3,
                notificationAnimation: settingsData.notificationAnimation || 'slide',
                notificationVolume: settingsData.notificationVolume || 50,
                notificationColors: settingsData.notificationColors || {
                    success: '#22c55e',
                    error: '#ef4444',
                    warning: '#f59e0b',
                    info: '#00d4ff'
                }
            };
            
            this.updateConfig(validSettings);
            this.showNotification('success', 'Ayarlar içe aktarıldı', 'success');
            
            setTimeout(() => {
                this.setupNotificationSettings();
            }, 100);
        } catch (error) {
            console.error('Import error:', error);
            this.showNotification('error', 'Ayarlar içe aktarılamadı', 'error');
        }
    }

    saveNotificationSettings() {
        try {
            const currentSettings = {
                notificationTheme: this.config.notificationTheme || 'default',
                notificationPosition: this.config.notificationPosition || 'top-right',
                notificationDuration: this.config.notificationDuration || 3,
                notificationAnimation: this.config.notificationAnimation || 'slide',
                notificationVolume: this.config.notificationVolume || 100,
                notificationBgColor: this.config.notificationBgColor || '#1a1a1a',
                notificationTextColor: this.config.notificationTextColor || '#ffffff',
                notificationBorderColor: this.config.notificationBorderColor || '#00d4ff'
            };
            
            this.updateConfig(currentSettings);
            
            this.resetPresetSelection();
            
            this.showNotification('success', 'Kaydedildi', 'success');
            
        } catch (error) {
            console.error('Save error:', error);
            this.showNotification('error', 'Ayarlar kaydedilemedi', 'error');
        }
    }

    testCustomSound() {
        if (this.config.notificationSoundFile) {
            this.playCustomNotificationSound(this.config.notificationSoundFile);
            this.showNotification('info', 'Özel ses test ediliyor...', 'info');
        } else {
            this.playDefaultNotificationSound();
            this.showNotification('info', 'Varsayılan ses test ediliyor...', 'info');
        }
    }

    resetNotificationSettings() {
        try {
            const defaultSettings = {
                notificationTheme: 'default',
                notificationPosition: 'top-right',
                notificationDuration: 3,
                notificationAnimation: 'slide',
                notificationVolume: 100,
                notificationBgColor: '#1a1a1a',
                notificationTextColor: '#ffffff',
                notificationBorderColor: '#00d4ff'
            };
            
            this.config = { ...this.config, ...defaultSettings };
            
            this.applyEnhancedNotificationSettings();
            
            this.resetPresetSelection();
            
            this.showNotification('info', 'Ayarlar varsayılana sıfırlandı. Kaydetmek için "Kaydet" butonuna basın.', 'info');
            
        } catch (error) {
            console.error('Reset error:', error);
            this.showNotification('error', 'Ayarlar sıfırlanamadı', 'error');
        }
    }

    exportNotificationSettings() {
        try {
            const settings = {
                notificationTheme: this.config.notificationTheme || 'default',
                notificationPosition: this.config.notificationPosition || 'top-right',
                notificationDuration: this.config.notificationDuration || 3,
                notificationAnimation: this.config.notificationAnimation || 'slide',
                notificationVolume: this.config.notificationVolume || 100,
                notificationBgColor: this.config.notificationBgColor || '#1a1a1a',
                notificationTextColor: this.config.notificationTextColor || '#ffffff',
                notificationBorderColor: this.config.notificationBorderColor || '#00d4ff'
            };
            
            const dataStr = JSON.stringify(settings, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(dataBlob);
            
            const link = document.createElement('a');
            link.href = url;
            link.download = 'notification-settings.json';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            URL.revokeObjectURL(url);
            
            this.showNotification('success', 'Ayarlar başarıyla dışa aktarıldı', 'success');
            
        } catch (error) {
            console.error('Export error:', error);
            this.showNotification('error', 'Ayarlar dışa aktarılamadı', 'error');
        }
    }

    async importNotificationSettings(file) {
        try {
            const text = await file.text();
            const settings = JSON.parse(text);
            
            this.config = { ...this.config, ...settings };
            
            this.applyEnhancedNotificationSettings();
            
            this.resetPresetSelection();
            
            this.showNotification('info', 'Ayarlar içe aktarıldı. Kaydetmek için "Kaydet" butonuna basın.', 'info');
            
        } catch (error) {
            console.error('Import error:', error);
            this.showNotification('error', 'Ayarlar içe aktarılamadı', 'error');
        }
    }

    updateNotificationSettingsUI() {
        this.applyEnhancedNotificationSettings();
    }

    setupAdvancedDurationSlider() {
        const advancedDurationSlider = document.getElementById('advancedDurationSlider');
        const advancedDurationValue = document.getElementById('advancedDurationValue');
        
        if (advancedDurationSlider && advancedDurationValue) {
            advancedDurationSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                advancedDurationValue.textContent = value;
                this.config.notificationDuration = parseInt(value);
            });
        }
    }

    setupNewNotificationSettings() {
        const styleItems = document.querySelectorAll('.style-item');
        styleItems.forEach(item => {
            item.addEventListener('click', () => {
                styleItems.forEach(style => style.classList.remove('active'));
                item.classList.add('active');
                
                const style = item.getAttribute('data-style');
                this.config.notificationStyle = style;
                this.updateConfig({ notificationStyle: style });
            });
        });

        const soundToggle = document.getElementById('notificationSoundEnabled');
        if (soundToggle) {
            soundToggle.addEventListener('change', (e) => {
                const enabled = e.target.checked;
                this.config.notificationSoundEnabled = enabled;
                this.updateConfig({ notificationSoundEnabled: enabled });
            });
        }

        const volumeSlider = document.getElementById('notificationVolume');
        const volumeValue = volumeSlider?.nextElementSibling;
        if (volumeSlider && volumeValue) {
            volumeSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                volumeValue.textContent = value + '%';
                this.config.notificationVolume = parseInt(value);
                this.updateConfig({ notificationVolume: parseInt(value) });
            });
        }

        const durationSlider = document.getElementById('notificationDuration');
        const durationValue = durationSlider?.nextElementSibling;
        if (durationSlider && durationValue) {
            durationSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                durationValue.textContent = value + ' saniye';
                this.config.notificationDuration = parseInt(value);
                this.updateConfig({ notificationDuration: parseInt(value) });
            });
        }

        const exportBtn = document.getElementById('notificationExport');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                this.exportNotificationSettings();
            });
        }

        const importFile = document.getElementById('notificationImport');
        if (importFile) {
            importFile.addEventListener('change', (e) => {
                this.importNotificationSettings(e);
            });
        }

        this.applyNewNotificationSettings();
    }

    applyNewNotificationSettings() {
        const currentStyle = this.config.notificationStyle || 'modern';
        const styleItem = document.querySelector(`.style-item[data-style="${currentStyle}"]`);
        if (styleItem) {
            document.querySelectorAll('.style-item').forEach(item => item.classList.remove('active'));
            styleItem.classList.add('active');
        }

        const soundToggle = document.getElementById('notificationSoundEnabled');
        if (soundToggle) {
            soundToggle.checked = this.config.notificationSoundEnabled !== false;
        }

        const volumeSlider = document.getElementById('notificationVolume');
        const volumeValue = volumeSlider?.nextElementSibling;
        if (volumeSlider && volumeValue) {
            const volume = this.config.notificationVolume || 100;
            volumeSlider.value = volume;
            volumeValue.textContent = volume + '%';
        }

        const durationSlider = document.getElementById('notificationDuration');
        const durationValue = durationSlider?.nextElementSibling;
        if (durationSlider && durationValue) {
            const duration = this.config.notificationDuration || 3;
            durationSlider.value = duration;
            durationValue.textContent = duration + ' saniye';
        }
    }

    setupCompactNotificationSettings() {
        const themeSelect = document.getElementById('notificationThemeSelect');
        if (themeSelect) {
            themeSelect.addEventListener('change', (e) => {
                this.config.notificationTheme = e.target.value;
            });
        }

        const positionSelect = document.getElementById('notificationPositionSelect');
        if (positionSelect) {
            positionSelect.addEventListener('change', (e) => {
                this.config.notificationPosition = e.target.value;
            });
        }

        const durationSlider = document.getElementById('notificationDurationSlider');
        const durationValue = document.getElementById('notificationDurationValue');
        if (durationSlider && durationValue) {
            durationSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                durationValue.textContent = value;
                this.config.notificationDuration = parseInt(value);
            });
        }

        const animationSelect = document.getElementById('notificationAnimationSelect');
        if (animationSelect) {
            animationSelect.addEventListener('change', (e) => {
                this.config.notificationAnimation = e.target.value;
            });
        }

        const volumeSlider = document.getElementById('soundVolumeSlider');
        const volumeValue = document.getElementById('soundVolumeValue');
        if (volumeSlider && volumeValue) {
            volumeSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                volumeValue.textContent = value + '%';
                this.config.notificationVolume = parseInt(value);
            });
        }

        const selectSoundBtn = document.getElementById('selectSoundFileBtn');
        if (selectSoundBtn) {
            selectSoundBtn.addEventListener('click', () => {
                this.selectSoundFile();
            });
        }

        const previewSuccessBtn = document.getElementById('previewSuccessBtn');
        const previewErrorBtn = document.getElementById('previewErrorBtn');
        const previewWarningBtn = document.getElementById('previewWarningBtn');
        const previewInfoBtn = document.getElementById('previewInfoBtn');

        if (previewSuccessBtn) {
            previewSuccessBtn.addEventListener('click', () => {
                this.testNotification('success', 'Bu bir başarı bildirimidir!', 'success');
            });
        }
        if (previewErrorBtn) {
            previewErrorBtn.addEventListener('click', () => {
                this.testNotification('error', 'Bu bir hata bildirimidir!', 'error');
            });
        }
        if (previewWarningBtn) {
            previewWarningBtn.addEventListener('click', () => {
                this.testNotification('warning', 'Bu bir uyarı bildirimidir!', 'warning');
            });
        }
        if (previewInfoBtn) {
            previewInfoBtn.addEventListener('click', () => {
                this.testNotification('info', 'Bu bir bilgi bildirimidir!', 'info');
            });
        }

        this.applyCompactNotificationSettings();
    }

    setupEnhancedNotificationSettings() {
        const volumeSlider = document.getElementById('notificationVolume');
        const volumeValue = document.getElementById('volumeValue');
        
        if (volumeSlider) {
            volumeSlider.value = this.config.notificationVolume || 100;
            if (volumeValue) volumeValue.textContent = volumeSlider.value;
            
            volumeSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                if (volumeValue) volumeValue.textContent = value;
                this.config.notificationVolume = parseInt(value);
                this.updateConfigSilent({ notificationVolume: parseInt(value) });
            });
        }
        
        const durationSlider = document.getElementById('notificationDuration');
        const durationValue = document.getElementById('durationValue');
        
        if (durationSlider) {
            durationSlider.value = this.config.notificationDuration || 3;
            if (durationValue) durationValue.textContent = durationSlider.value;
            
            durationSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                if (durationValue) durationValue.textContent = value;
                this.config.notificationDuration = parseInt(value);
                this.updateConfigSilent({ notificationDuration: parseInt(value) });
            });
        }
        
        const animationOptions = document.querySelectorAll('.animation-option');
        animationOptions.forEach(option => {
            option.addEventListener('click', () => {
                animationOptions.forEach(opt => opt.classList.remove('active'));
                option.classList.add('active');
                const animation = option.dataset.animation;
                this.config.notificationAnimation = animation;
                this.updateConfigSilent({ notificationAnimation: animation });
                this.showTestNotification('info');
            });
        });
        
        const styleOptions = document.querySelectorAll('.style-option');
        styleOptions.forEach(option => {
            option.addEventListener('click', () => {
                styleOptions.forEach(opt => opt.classList.remove('active'));
                option.classList.add('active');
                const style = option.dataset.style;
                this.config.notificationStyle = style;
                this.updateConfigSilent({ notificationStyle: style });
                this.showTestNotification('info');
            });
        });
    }

    setupNotificationSettings() {
        const soundToggle = document.getElementById('notificationSoundEnabled');
        if (soundToggle) {
            soundToggle.checked = this.config.notificationVolume > 0;
            soundToggle.addEventListener('change', (e) => {
                if (e.target.checked) {
                    this.config.notificationVolume = 100;
                    const volumeSlider = document.getElementById('notificationVolume');
                    if (volumeSlider) volumeSlider.value = 100;
                    const volumeValue = document.querySelector('.volume-value');
                    if (volumeValue) volumeValue.textContent = '100%';
                } else {
                    this.config.notificationVolume = 0;
                    const volumeSlider = document.getElementById('notificationVolume');
                    if (volumeSlider) volumeSlider.value = 0;
                    const volumeValue = document.querySelector('.volume-value');
                    if (volumeValue) volumeValue.textContent = '0%';
                }
                this.updateConfigSilent({ notificationVolume: this.config.notificationVolume });
            });
        }

        const volumeSlider = document.getElementById('notificationVolume');
        const volumeValue = document.querySelector('.volume-value');
        if (volumeSlider) {
            volumeSlider.value = this.config.notificationVolume || 100;
            if (volumeValue) volumeValue.textContent = volumeSlider.value + '%';
            
            volumeSlider.addEventListener('input', (e) => {
                const value = parseInt(e.target.value);
                if (volumeValue) volumeValue.textContent = value + '%';
                this.config.notificationVolume = value;
                this.updateConfigSilent({ notificationVolume: value });
                
                if (soundToggle) soundToggle.checked = value > 0;
            });
        }

        const durationSlider = document.getElementById('notificationDuration');
        const durationValue = document.querySelector('.duration-value');
        if (durationSlider) {
            durationSlider.value = this.config.notificationDuration || 3;
            if (durationValue) durationValue.innerHTML = durationSlider.value + ' <span data-i18n="seconds">saniye</span>';
            
            durationSlider.addEventListener('input', (e) => {
                const value = parseInt(e.target.value);
                if (durationValue) durationValue.innerHTML = value + ' <span data-i18n="seconds">saniye</span>';
                this.config.notificationDuration = value;
                this.updateConfigSilent({ notificationDuration: value });
            });
        }

        const styleItems = document.querySelectorAll('.style-item');
        styleItems.forEach(item => {
            item.addEventListener('click', () => {
                styleItems.forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                const style = item.dataset.style;
                this.config.notificationStyle = style;
                this.updateConfigSilent({ notificationStyle: style });
                this.showTestNotification('info');
            });
        });
        
        this.applyNotificationStyleToUI();

        const testButtons = document.querySelectorAll('.test-btn[data-test-type]');
        testButtons.forEach(button => {
            button.addEventListener('click', () => {
                const testType = button.dataset.testType;
                this.showTestNotification(testType);
            });
        });

        const saveBtn = document.getElementById('notificationSave');
        const resetBtn = document.getElementById('notificationReset');
        const exportBtn = document.getElementById('notificationExport');
        const importBtn = document.getElementById('notificationImport');

        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                this.updateConfig(this.config);
                this.showNotification('Başarılı', 'Bildirim ayarları kaydedildi!', 'success');
            });
        }

        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this.config.notificationVolume = 100;
                this.config.notificationDuration = 3;
                this.config.notificationStyle = 'modern';
                this.config.notificationAnimation = 'slide';
                this.updateConfig(this.config);
                this.setupNotificationSettings(); // Reload UI
                this.showNotification('Sıfırlandı', 'Bildirim ayarları varsayılana döndürüldü!', 'info');
            });
        }

        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                this.exportNotificationSettings();
            });
        }

        if (importBtn) {
            importBtn.addEventListener('change', (e) => {
                this.importNotificationSettings(e);
            });
        }

        const previewSuccessBtn = document.getElementById('previewSuccessBtn');
        const previewErrorBtn = document.getElementById('previewErrorBtn');
        const previewWarningBtn = document.getElementById('previewWarningBtn');
        const previewInfoBtn = document.getElementById('previewInfoBtn');

        if (previewSuccessBtn) {
            previewSuccessBtn.addEventListener('click', () => {
                this.showNotification('success', 'Bu bir başarı bildirimidir!', 'success');
            });
        }
        if (previewErrorBtn) {
            previewErrorBtn.addEventListener('click', () => {
                this.showNotification('error', 'Bu bir hata bildirimidir!', 'error');
            });
        }
        if (previewWarningBtn) {
            previewWarningBtn.addEventListener('click', () => {
                this.showNotification('warning', 'Bu bir uyarı bildirimidir!', 'warning');
            });
        }
        if (previewInfoBtn) {
            previewInfoBtn.addEventListener('click', () => {
                this.showNotification('info', 'Bu bir bilgi bildirimidir!', 'info');
            });
        }

        const saveBtn2 = document.getElementById('saveNotificationSettingsBtn');
        const resetBtn2 = document.getElementById('resetNotificationSettingsBtn');
        const exportBtn2 = document.getElementById('exportNotificationSettingsBtn');
        const importBtn2 = document.getElementById('importNotificationSettingsBtn');

        if (saveBtn2) {
            saveBtn2.addEventListener('click', () => {
                this.saveNotificationSettings();
            });
        }
        if (resetBtn2) {
            resetBtn2.addEventListener('click', () => {
                this.resetNotificationSettings();
            });
        }
        if (exportBtn2) {
            exportBtn2.addEventListener('click', () => {
                this.exportNotificationSettings();
            });
        }
        if (importBtn2) {
            importBtn2.addEventListener('click', () => {
                document.getElementById('importNotificationSettingsFile').click();
            });
        }

        const importFile2 = document.getElementById('importNotificationSettingsFile');
        if (importFile2) {
            importFile2.addEventListener('change', (e) => {
                this.importNotificationSettings(e);
            });
        }

        this.applyEnhancedNotificationSettings();
    }

    applyNotificationStyleToUI() {
        const currentStyle = this.config.notificationStyle || 'modern';
        const styleItems = document.querySelectorAll('.style-item');
        styleItems.forEach(item => {
            if (item.dataset.style === currentStyle) {
                item.classList.add('active');
            } else {
                item.classList.remove('active');
            }
        });
    }

    applyCompactNotificationSettings() {
        const themeSelect = document.getElementById('notificationThemeSelect');
        if (themeSelect) {
            themeSelect.value = this.config.notificationTheme || 'default';
        }

        const positionSelect = document.getElementById('notificationPositionSelect');
        if (positionSelect) {
            positionSelect.value = this.config.notificationPosition || 'top-right';
        }

        const durationSlider = document.getElementById('notificationDurationSlider');
        const durationValue = document.getElementById('notificationDurationValue');
        if (durationSlider && durationValue) {
            const duration = this.config.notificationDuration || 3;
            durationSlider.value = duration;
            durationValue.textContent = duration;
        }

        const animationSelect = document.getElementById('notificationAnimationSelect');
        if (animationSelect) {
            animationSelect.value = this.config.notificationAnimation || 'slide';
        }

        const volumeSlider = document.getElementById('soundVolumeSlider');
        const volumeValue = document.getElementById('soundVolumeValue');
        if (volumeSlider && volumeValue) {
            const volume = this.config.notificationVolume || 100;
            volumeSlider.value = volume;
            volumeValue.textContent = volume + '%';
        }
    }

    applyEnhancedNotificationSettings() {
        const durationSlider = document.getElementById('advancedDurationSlider');
        const durationValue = document.getElementById('advancedDurationValue');
        if (durationSlider && durationValue) {
            const duration = this.config.notificationDuration || 3;
            durationSlider.value = duration;
            durationValue.textContent = duration;
        }

        const volumeSlider = document.getElementById('advancedSoundVolumeSlider');
        const volumeValue = document.getElementById('advancedSoundVolumeValue');
        if (volumeSlider && volumeValue) {
            const volume = this.config.notificationVolume || 100;
            volumeSlider.value = volume;
            volumeValue.textContent = volume + '%';
        }

        this.applyNotificationTheme();
        this.applyNotificationPosition();

        const bgColorPicker = document.getElementById('notificationBgColor');
        const textColorPicker = document.getElementById('notificationTextColor');
        const borderColorPicker = document.getElementById('notificationBorderColor');

        if (bgColorPicker) {
            bgColorPicker.value = this.config.notificationBgColor || '#1a1a1a';
        }
        if (textColorPicker) {
            textColorPicker.value = this.config.notificationTextColor || '#ffffff';
        }
        if (borderColorPicker) {
            borderColorPicker.value = this.config.notificationBorderColor || '#00d4ff';
        }

        this.applyNotificationTypeColors();
        
        this.updateSoundFileDisplay();
        
        const presetSelect = document.getElementById('notificationPresetSelect');
        if (presetSelect) {
            const currentSettings = {
                notificationTheme: this.config.notificationTheme || 'default',
                notificationPosition: this.config.notificationPosition || 'top-right',
                notificationDuration: this.config.notificationDuration || 3,
                notificationAnimation: this.config.notificationAnimation || 'slide',
                notificationVolume: this.config.notificationVolume || 100,
                notificationBgColor: this.config.notificationBgColor || '#1a1a1a',
                notificationTextColor: this.config.notificationTextColor || '#ffffff',
                notificationBorderColor: this.config.notificationBorderColor || '#00d4ff'
            };
            
            let matchingPreset = '';
            for (const [presetId, preset] of Object.entries(this.notificationPresets)) {
                if (JSON.stringify(preset) === JSON.stringify(currentSettings)) {
                    matchingPreset = presetId;
                    break;
                }
            }
            
            presetSelect.value = matchingPreset;
        }
    }

    applyNotificationTypeColors() {
        const typeColors = this.config.notificationTypeColors || {};
        
        const infoBgColor = document.getElementById('infoBgColor');
        const infoTextColor = document.getElementById('infoTextColor');
        const infoBorderColor = document.getElementById('infoBorderColor');
        
        if (infoBgColor) infoBgColor.value = typeColors.info?.bg || '#0f172a';
        if (infoTextColor) infoTextColor.value = typeColors.info?.text || '#f8fafc';
        if (infoBorderColor) infoBorderColor.value = typeColors.info?.border || '#0ea5e9';
        
        const successBgColor = document.getElementById('successBgColor');
        const successTextColor = document.getElementById('successTextColor');
        const successBorderColor = document.getElementById('successBorderColor');
        
        if (successBgColor) successBgColor.value = typeColors.success?.bg || '#064e3b';
        if (successTextColor) successTextColor.value = typeColors.success?.text || '#d1fae5';
        if (successBorderColor) successBorderColor.value = typeColors.success?.border || '#10b981';
        
        const warningBgColor = document.getElementById('warningBgColor');
        const warningTextColor = document.getElementById('warningTextColor');
        const warningBorderColor = document.getElementById('warningBorderColor');
        
        if (warningBgColor) warningBgColor.value = typeColors.warning?.bg || '#451a03';
        if (warningTextColor) warningTextColor.value = typeColors.warning?.text || '#fef3c7';
        if (warningBorderColor) warningBorderColor.value = typeColors.warning?.border || '#f59e0b';
        
        const errorBgColor = document.getElementById('errorBgColor');
        const errorTextColor = document.getElementById('errorTextColor');
        const errorBorderColor = document.getElementById('errorBorderColor');
        
        if (errorBgColor) errorBgColor.value = typeColors.error?.bg || '#450a0a';
        if (errorTextColor) errorTextColor.value = typeColors.error?.text || '#fee2e2';
        if (errorBorderColor) errorBorderColor.value = typeColors.error?.border || '#ef4444';
    }

    updateSoundFileDisplay() {
        const selectedSoundFileName = document.getElementById('selectedSoundFileName');
        if (selectedSoundFileName) {
            if (this.config.notificationSoundFile && this.config.notificationSoundFile.name) {
                selectedSoundFileName.textContent = this.config.notificationSoundFile.name;
                selectedSoundFileName.className = 'selected-file-name has-file';
            } else {
                selectedSoundFileName.textContent = 'Varsayılan ses kullanılıyor';
                selectedSoundFileName.className = 'selected-file-name';
            }
        }
    }

    setupNotificationSettingsHandlers() {
        const durationSlider = document.getElementById('advancedDurationSlider');
        if (durationSlider) {
            durationSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                const durationValue = document.getElementById('advancedDurationValue');
                if (durationValue) {
                    durationValue.textContent = value;
                }
                this.config.notificationDuration = parseInt(value);
                
                this.updateConfig(this.config);
            });
        }

        const volumeSlider = document.getElementById('advancedSoundVolumeSlider');
        if (volumeSlider) {
            volumeSlider.addEventListener('input', (e) => {
                const value = e.target.value;
                const volumeValue = document.getElementById('advancedSoundVolumeValue');
                if (volumeValue) {
                    volumeValue.textContent = value + '%';
                }
                this.config.notificationVolume = parseInt(value);
                
                this.updateConfig(this.config);
            });
        }

        this.setupStyleHandlers();

        this.setupAnimationHandlers();

        this.setupActionButtonHandlers();
    }

    setupStyleHandlers() {
        const styleOptions = document.querySelectorAll('.style-option-modern');
        styleOptions.forEach(option => {
            option.addEventListener('click', (e) => {
                styleOptions.forEach(opt => opt.classList.remove('active'));
                
                option.classList.add('active');
                
                const style = option.dataset.style;
                this.config.notificationStyle = style;
                this.updateConfig(this.config);
                
                this.showNotification('Test', `${style.charAt(0).toUpperCase() + style.slice(1)} stili uygulandı!`, 'info');
            });
        });
    }

    setupAnimationHandlers() {
        const animationOptions = document.querySelectorAll('.animation-option-enhanced');
        animationOptions.forEach(option => {
            option.addEventListener('click', (e) => {
                animationOptions.forEach(opt => opt.classList.remove('active'));
                
                option.classList.add('active');
                
                const animation = option.dataset.animation;
                this.config.notificationAnimation = animation;
                this.updateConfig(this.config);
                
                this.showNotification('Test', 'Animasyon değişikliği test ediliyor...', 'info');
            });
        });
    }

    setupActionButtonHandlers() {
        const saveBtn = document.getElementById('saveNotificationSettingsBtn');
        if (saveBtn) {
            saveBtn.addEventListener('click', () => {
                this.saveNotificationSettings();
            });
        }

        const resetBtn = document.getElementById('resetNotificationSettingsBtn');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                this.resetNotificationSettings();
            });
        }

        const exportBtn = document.getElementById('exportNotificationSettingsBtn');
        if (exportBtn) {
            exportBtn.addEventListener('click', () => {
                this.exportNotificationSettings();
            });
        }

        const importBtn = document.getElementById('importNotificationSettingsBtn');
        if (importBtn) {
            importBtn.addEventListener('click', () => {
                this.importNotificationSettings();
            });
        }

        const resetSoundBtn = document.getElementById('resetSoundFileBtn');
        if (resetSoundBtn) {
            resetSoundBtn.addEventListener('click', () => {
                this.resetNotificationSound();
            });
        }
    }

    async saveNotificationSettings() {
        try {
            await this.updateConfig({
                notificationTheme: this.config.notificationTheme,
                notificationPosition: this.config.notificationPosition,
                notificationDuration: this.config.notificationDuration,
                notificationAnimation: this.config.notificationAnimation,
                notificationVolume: this.config.notificationVolume,
                notificationBgColor: this.config.notificationBgColor,
                notificationTextColor: this.config.notificationTextColor,
                notificationBorderColor: this.config.notificationBorderColor,
                notificationTypeColors: this.config.notificationTypeColors
            });

            this.showNotification('success', 'Bildirim ayarları kaydedildi!', 'success');
        } catch (error) {
            console.error('Ayarları kaydetme hatası:', error);
            this.showNotification('error', 'Ayarlar kaydedilemedi!', 'error');
        }
    }

    async resetNotificationSettings() {
        try {
            const defaultSettings = {
                notificationTheme: 'default',
                notificationPosition: 'top-right',
                notificationDuration: 3,
                notificationAnimation: 'slide',
                notificationVolume: 100,
                notificationBgColor: '#1a1a1a',
                notificationTextColor: '#ffffff',
                notificationBorderColor: '#00d4ff',
                notificationTypeColors: {
                    info: { bg: '#0f172a', text: '#f8fafc', border: '#0ea5e9' },
                    success: { bg: '#064e3b', text: '#d1fae5', border: '#10b981' },
                    warning: { bg: '#451a03', text: '#fef3c7', border: '#f59e0b' },
                    error: { bg: '#450a0a', text: '#fee2e2', border: '#ef4444' }
                }
            };

            this.config = { ...this.config, ...defaultSettings };
            
            this.applyEnhancedNotificationSettings();
            
            await this.updateConfig(defaultSettings);
            
            this.showNotification('success', 'Bildirim ayarları sıfırlandı!', 'success');
        } catch (error) {
            console.error('Ayarları sıfırlama hatası:', error);
            this.showNotification('error', 'Ayarlar sıfırlanamadı!', 'error');
        }
    }

    exportNotificationSettings() {
        try {
            const settings = {
                notificationTheme: this.config.notificationTheme,
                notificationPosition: this.config.notificationPosition,
                notificationDuration: this.config.notificationDuration,
                notificationAnimation: this.config.notificationAnimation,
                notificationVolume: this.config.notificationVolume,
                notificationBgColor: this.config.notificationBgColor,
                notificationTextColor: this.config.notificationTextColor,
                notificationBorderColor: this.config.notificationBorderColor,
                notificationTypeColors: this.config.notificationTypeColors
            };

            const dataStr = JSON.stringify(settings, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            
            const link = document.createElement('a');
            link.href = URL.createObjectURL(dataBlob);
            link.download = 'notification-settings.json';
            link.click();
            
            this.showNotification('success', 'Ayarlar dışa aktarıldı!', 'success');
        } catch (error) {
            console.error('Ayarları dışa aktarma hatası:', error);
            this.showNotification('error', 'Ayarlar dışa aktarılamadı!', 'error');
        }
    }

    async importNotificationSettings() {
        try {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            
            input.onchange = async (event) => {
                const file = event.target.files[0];
                if (file) {
                    try {
                        const text = await file.text();
                        const settings = JSON.parse(text);
                        
                        this.config = { ...this.config, ...settings };
                        
                        this.applyEnhancedNotificationSettings();
                        
                        await this.updateConfig(settings);
                        
                        this.showNotification('success', 'Ayarlar içe aktarıldı!', 'success');
                    } catch (error) {
                        console.error('Dosya okuma hatası:', error);
                        this.showNotification('error', 'Geçersiz ayar dosyası!', 'error');
                    }
                }
            };
            
            input.click();
        } catch (error) {
            console.error('Ayarları içe aktarma hatası:', error);
            this.showNotification('error', 'Ayarlar içe aktarılamadı!', 'error');
        }
    }

    async resetNotificationSound() {
        try {
            if (this.config.notificationSoundFile && this.config.notificationSoundFile.path) {
                await ipcRenderer.invoke('delete-notification-sound', this.config.notificationSoundFile.path);
            }
            
            this.config.notificationSoundFile = null;
            await this.updateConfig({ notificationSoundFile: null });
            
            this.updateSoundFileDisplay();
            
            this.showNotification('success', 'Ses dosyası sıfırlandı!', 'success');
        } catch (error) {
            console.error('Ses dosyası sıfırlama hatası:', error);
            this.showNotification('error', 'Ses dosyası sıfırlanamadı!', 'error');
        }
    }

    async selectSoundFile() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.mp3,.wav,.ogg';
        
        input.onchange = async (event) => {
            const file = event.target.files[0];
            if (file) {
                try {
                    if (this.config.notificationSoundFile && this.config.notificationSoundFile.path) {
                        await ipcRenderer.invoke('delete-notification-sound', this.config.notificationSoundFile.path);
                    }
                    
                    const arrayBuffer = await file.arrayBuffer();
                    const fileData = {
                        name: file.name,
                        buffer: arrayBuffer,
                        size: file.size
                    };
                    
                    const savedFile = await ipcRenderer.invoke('save-notification-sound', fileData);
                    
                    this.config.notificationSoundFile = savedFile;
                    await this.updateConfigSilent({ notificationSoundFile: savedFile });
                    
                    this.updateSoundFileDisplay();
                    
                    this.showTestNotification();
                } catch (error) {
                    console.error('Ses dosyası kaydetme hatası:', error);
                    this.showNotification('error', 'Ses dosyası kaydedilemedi!', 'error');
                }
            }
        };
        
        input.click();
    }

    applyNotificationPreset(presetId) {
        const preset = this.notificationPresets[presetId];
        if (!preset) return;

        this.config.notificationTheme = preset.notificationTheme;
        this.config.notificationPosition = preset.notificationPosition;
        this.config.notificationDuration = preset.notificationDuration;
        this.config.notificationAnimation = preset.notificationAnimation;
        this.config.notificationVolume = preset.notificationVolume;
        this.config.notificationBgColor = preset.notificationBgColor;
        this.config.notificationTextColor = preset.notificationTextColor;
        this.config.notificationBorderColor = preset.notificationBorderColor;

        this.applyEnhancedNotificationSettings();
        
        const presetSelect = document.getElementById('notificationPresetSelect');
        if (presetSelect) {
            presetSelect.value = presetId;
        }

        this.updateConfigSilent({
            notificationTheme: preset.notificationTheme,
            notificationPosition: preset.notificationPosition,
            notificationDuration: preset.notificationDuration,
            notificationAnimation: preset.notificationAnimation,
            notificationVolume: preset.notificationVolume,
            notificationBgColor: preset.notificationBgColor,
            notificationTextColor: preset.notificationTextColor,
            notificationBorderColor: preset.notificationBorderColor
        });
    }

    resetPresetSelection() {
        const presetSelect = document.getElementById('notificationPresetSelect');
        if (presetSelect) {
            presetSelect.value = '';
        }
    }

    applyNotificationTheme() {
        const container = document.getElementById('notificationContainer');
        if (!container) return;

        const theme = this.config.notificationTheme || 'default';
        container.className = `notification-container theme-${theme}`;
    }

    applyNotificationPosition() {
        const container = document.getElementById('notificationContainer');
        if (!container) return;

        const position = this.config.notificationPosition || 'top-right';
        container.className = `notification-container position-${position}`;
    }

    showTestNotification() {
        this.showNotification('Test', 'Ayar değişikliği test ediliyor...', 'info');
    }

    showTestNotificationByType(type) {
        const messages = {
            info: 'Bu bir bilgi bildirimidir',
            success: 'Bu bir başarı bildirimidir',
            warning: 'Bu bir uyarı bildirimidir',
            error: 'Bu bir hata bildirimidir'
        };
        
        this.showNotification('Test', messages[type] || messages.info, type);
    }

    setupPositionHandlers() {
        const positionOptions = document.querySelectorAll('.position-option');
        positionOptions.forEach(option => {
            option.addEventListener('click', (e) => {
                positionOptions.forEach(opt => opt.classList.remove('active'));
                
                option.classList.add('active');
                
                const position = option.dataset.position;
                this.config.notificationPosition = position;
                this.updateConfig(this.config);
            });
        });
    }

    setupQuickThemeHandlers() {
        const themeCards = document.querySelectorAll('.theme-card-modern');
        themeCards.forEach(card => {
            card.addEventListener('click', (e) => {
                themeCards.forEach(c => c.classList.remove('active'));
                
                card.classList.add('active');
                
                const presetId = card.dataset.preset;
                this.applyNotificationPreset(presetId);
            });
        });
    }

    applyNotificationPreset(presetId) {
        const preset = this.notificationPresets[presetId];
        if (!preset) return;

        const systemTheme = this.getCurrentSystemTheme();
        
        const adaptedPreset = this.adaptPresetToSystemTheme(preset, systemTheme);
        
        const currentPosition = this.config.notificationPosition;
        
        Object.assign(this.config, adaptedPreset);
        
        this.config.notificationPosition = currentPosition;

        this.updateConfig(this.config);
        
        this.applyEnhancedNotificationSettings();
        this.updatePositionSelection();
        
        this.showNotification('Test', `${preset.name} teması sistem temasına uygun şekilde uygulandı!`, 'success');
    }

    getCurrentSystemTheme() {
        const body = document.body;
        if (body.classList.contains('theme-dark')) return 'dark';
        if (body.classList.contains('theme-light')) return 'light';
        if (body.classList.contains('theme-blue')) return 'blue';
        if (body.classList.contains('theme-green')) return 'green';
        if (body.classList.contains('theme-purple')) return 'purple';
        return 'default';
    }

    adaptPresetToSystemTheme(preset, systemTheme) {
        const adapted = { ...preset };
        
        switch (systemTheme) {
            case 'dark':
                adapted.notificationBgColor = '#1a1a1a';
                adapted.notificationTextColor = '#ffffff';
                adapted.notificationBorderColor = '#00d4ff';
                break;
            case 'light':
                adapted.notificationBgColor = '#f8fafc';
                adapted.notificationTextColor = '#334155';
                adapted.notificationBorderColor = '#cbd5e1';
                break;
            case 'blue':
                adapted.notificationBgColor = '#0f172a';
                adapted.notificationTextColor = '#f8fafc';
                adapted.notificationBorderColor = '#0ea5e9';
                break;
            case 'green':
                adapted.notificationBgColor = '#064e3b';
                adapted.notificationTextColor = '#d1fae5';
                adapted.notificationBorderColor = '#10b981';
                break;
            case 'purple':
                adapted.notificationBgColor = '#1e1b4b';
                adapted.notificationTextColor = '#e5e7eb';
                adapted.notificationBorderColor = '#8b5cf6';
                break;
            default:
                break;
        }
        
        return adapted;
    }

    updatePositionSelection() {
        const positionOptions = document.querySelectorAll('.position-option');
        positionOptions.forEach(option => {
            option.classList.remove('active');
            if (option.dataset.position === this.config.notificationPosition) {
                option.classList.add('active');
            }
        });
    }

    resetNotificationSound() {
        if (this.config.notificationSoundFile && this.config.notificationSoundFile.path) {
            ipcRenderer.invoke('delete-notification-sound', this.config.notificationSoundFile.path)
                .then(() => {
                    console.log('Özel ses dosyası silindi');
                })
                .catch(err => {
                    console.error('Ses dosyası silinirken hata:', err);
                });
        }
        
        this.config.notificationSoundFile = null;
        this.config.notificationSound = true; // Varsayılan sesi kullan
        
        const selectedFileName = document.getElementById('selectedSoundFileName');
        if (selectedFileName) {
            selectedFileName.textContent = 'Varsayılan ses kullanılıyor';
            selectedFileName.className = 'selected-file-name';
        }
        
        this.updateConfig(this.config);
        
        this.showNotification('Başarılı', 'Bildirim sesi varsayılana sıfırlandı', 'success');
    }

    showNotification(title, message, type = 'info') {
        const notifTitle = this.translate(title) || title;
        const notifMsg = this.translate(message) || message;
        
        const notification = document.createElement('div');
        const animation = this.config.notificationAnimation || 'slide';
        const style = this.config.notificationStyle || 'modern';
        
        const themeColors = this.getSystemThemeColors();
        
        notification.className = `notification ${type} animation-${animation} style-${style}`;
        
        console.log('Notification created with:', { type, animation, style, className: notification.className });
        
        
        notification.innerHTML = `
            <div class="notification-icon">
                ${this.getNotificationIcon(type)}
            </div>
            <div class="notification-content">
                <div class="notification-title">${notifTitle}</div>
            <div class="notification-message">${notifMsg}</div>
            </div>
            <button class="notification-close" onclick="this.parentElement.remove()">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"/>
                    <line x1="6" y1="6" x2="18" y2="18"/>
                </svg>
            </button>
        `;
        
        const container = document.getElementById('notificationContainer');
        if (container) {
            container.appendChild(notification);
        } else {
            console.error('notificationContainer bulunamadı!');
            document.body.appendChild(notification);
        }
        
        this.playNotificationSound(type).catch(error => {
            console.log('Failed to play notification sound:', error);
        });
        
        const duration = 3000;
        setTimeout(() => {
            if (notification.parentElement) {
                notification.classList.add('notification-hide');
                setTimeout(() => {
                    if (notification.parentElement) {
            notification.remove();
                    }
                }, 300);
            }
        }, duration);
    }

    getSystemThemeColors() {
        const body = document.body;
        
        if (body.classList.contains('theme-dark')) {
            return {
                background: '#1a1a1a',
                text: '#ffffff',
                border: '#00d4ff',
                accent: '#00d4ff'
            };
        } else if (body.classList.contains('theme-light')) {
            return {
                background: '#f8fafc',
                text: '#334155',
                border: '#cbd5e1',
                accent: '#3b82f6'
            };
        } else if (body.classList.contains('theme-blue')) {
            return {
                background: '#0f172a',
                text: '#f8fafc',
                border: '#0ea5e9',
                accent: '#0ea5e9'
            };
        } else if (body.classList.contains('theme-green')) {
            return {
                background: '#064e3b',
                text: '#d1fae5',
                border: '#10b981',
                accent: '#10b981'
            };
        } else if (body.classList.contains('theme-purple')) {
            return {
                background: '#1e1b4b',
                text: '#e5e7eb',
                border: '#8b5cf6',
                accent: '#8b5cf6'
            };
        } else if (body.classList.contains('theme-neon')) {
            return {
                background: '#0a0a0a',
                text: '#00ff00',
                border: '#00ff00',
                accent: '#00ff00'
            };
        } else if (body.classList.contains('theme-sunset')) {
            return {
                background: '#451a03',
                text: '#fed7aa',
                border: '#f97316',
                accent: '#f97316'
            };
        } else {
            return {
                background: '#1a1a1a',
                text: '#ffffff',
                border: '#00d4ff',
                accent: '#00d4ff'
            };
        }
    }

    getNotificationIcon(type) {
        const icons = {
            success: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22,4 12,14.01 9,11.01"/></svg>',
            error: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
            warning: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
            info: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>'
        };
        return icons[type] || icons.info;
    }

    getNotificationColor(type) {
        const colors = this.config.notificationColors || {
            success: '#22c55e',
            error: '#ef4444',
            warning: '#f59e0b',
            info: '#00d4ff'
        };
        return colors[type] || colors.info;
    }

    async playNotificationSound(type) {
        if (this.config.notificationVolume === 0) return;
        
        try {
            await this.playDefaultNotificationSound();
        } catch (error) {
            console.log('Notification sound playback failed:', error);
        }
    }

    playCustomNotificationSound(soundFile) {
        try {
            const audio = new Audio();
            
            if (soundFile instanceof File) {
                audio.src = URL.createObjectURL(soundFile);
            } else if (soundFile.path) {
                audio.src = soundFile.path.startsWith('file://') ? soundFile.path : `file://${soundFile.path}`;
            } else {
                throw new Error('Invalid sound file format');
            }
            
            audio.volume = (this.config.notificationVolume || 100) / 100;
            
            const notificationDuration = (this.config.notificationDuration || 3) * 1000;
            
            audio.play().then(() => {
                setTimeout(() => {
                    audio.pause();
                    audio.currentTime = 0;
                    if (soundFile instanceof File) {
                        URL.revokeObjectURL(audio.src);
                    }
                }, notificationDuration);
            }).catch(error => {
                console.log('Custom sound playback failed:', error);
                this.playDefaultNotificationSound();
            });
        } catch (error) {
            console.log('Custom sound not supported:', error);
            this.playDefaultNotificationSound();
        }
    }

    async playDefaultNotificationSound() {
        try {
            if (!this.audioContext) {
                this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            
            if (this.audioContext.state === 'suspended') {
                await this.audioContext.resume();
            }
            
            const oscillator = this.audioContext.createOscillator();
            const gainNode = this.audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(this.audioContext.destination);
            
            oscillator.frequency.setValueAtTime(800, this.audioContext.currentTime);
            oscillator.type = 'sine';
            
            const volume = (this.config.notificationVolume || 100) / 100;
            gainNode.gain.setValueAtTime(volume * 0.3, this.audioContext.currentTime);
            gainNode.gain.exponentialRampToValueAtTime(0.01, this.audioContext.currentTime + 0.2);
            
            oscillator.start(this.audioContext.currentTime);
            oscillator.stop(this.audioContext.currentTime + 0.2);
            
            console.log('Notification sound played successfully');
        } catch (error) {
            console.log('Default sound playback failed:', error);
            this.playFallbackNotificationSound();
        }
    }

    playFallbackNotificationSound() {
        try {
            const audio = new Audio();
            const audioContext = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioContext.createOscillator();
            const gainNode = audioContext.createGain();
            
            oscillator.connect(gainNode);
            gainNode.connect(audioContext.destination);
            
            oscillator.frequency.setValueAtTime(600, audioContext.currentTime);
            oscillator.type = 'square';
            
            const volume = (this.config.notificationVolume || 100) / 100;
            gainNode.gain.setValueAtTime(volume * 0.1, audioContext.currentTime);
            
            oscillator.start(audioContext.currentTime);
            oscillator.stop(audioContext.currentTime + 0.1);
            
            console.log('Fallback notification sound played');
        } catch (error) {
            console.log('Fallback sound also failed:', error);
        }
    }

    launchGame(appId) {
        ipcRenderer.invoke('open-external', `steam://run/${appId}`);
        this.showNotification('success', this.translate('launching_game'), 'success');
    }

    async getGameImageUrl(appId, gameName) {
        return await this.getSharedHeader(appId);
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

    async handleSearch(query, enterPressed = false) {
        const cc = this.countryCode || 'TR';
        const lang = this.getSelectedLang();
        const heroSection = document.getElementById('heroSection');
        
        if (!enterPressed && (!query || query.length < 2)) {
            this.loadGames();
            if (heroSection) heroSection.style.display = '';
            this.removeSearchBackButton();
            return;
        }

        if (this.searchTimeout) {
            clearTimeout(this.searchTimeout);
        }

        this.searchTimeout = setTimeout(async () => {
            const currentPage = this.getCurrentPage();
            
            switch (currentPage) {
                case 'home':
            await this.performSearch(query.trim(), cc, lang, heroSection);
                    break;
                case 'repairFix':
                    await this.performRepairFixSearch(query.trim());
                    break;
                case 'bypass':
                    await this.performBypassSearch(query.trim());
                    break;
                case 'library':
                    await this.performLibrarySearch(query.trim());
                    break;
                default:
                    await this.performSearch(query.trim(), cc, lang, heroSection);
                    break;
            }
        }, 300);
    }

    removeSearchBackButton() {
        const backBtn = document.getElementById('searchBackBtn');
        if (backBtn) backBtn.remove();
    }

    clearSearch() {
        const searchInput = document.getElementById('searchInput');
        if (searchInput) {
            searchInput.value = '';
        }
        
        const currentPage = this.getCurrentPage();
        
        switch (currentPage) {
            case 'home':
                this.loadGames();
                break;
            case 'repairFix':
                if (this.repairFixGames) {
                    this.displayRepairFixSearchResults(this.repairFixGames, document.getElementById('repairFixGrid'));
                }
                break;
            case 'bypass':
                if (this.bypassGames) {
                    this.displayBypassSearchResults(this.bypassGames, document.getElementById('bypassGrid'));
                }
                break;
            case 'library':
                if (this.libraryGames) {
                    this.displayLibrarySearchResults(this.libraryGames, document.getElementById('libraryGrid'));
                }
                break;
            default:
                this.loadGames();
                break;
        }
        
        this.removeSearchBackButton();
        
        const heroSection = document.getElementById('heroSection');
        if (heroSection) heroSection.style.display = '';
    }

    async performSearch(query, cc, lang, heroSection) {
        const gamesGrid = document.getElementById('gamesGrid');
        if (!gamesGrid) return;

        this.addSearchBackButton(gamesGrid, heroSection);

        if (!query) return;

        try {
            this.showLoading(this.translate('searching_games'));
            gamesGrid.innerHTML = `<div class="search-loading">${this.translate('searching_for')} "${query}"...</div>`;
            
            if (heroSection) heroSection.style.display = 'none';

            let games = [];
            
            if (/^\d+$/.test(query)) {
                games = await this.searchByAppId(query, cc, lang);
            } else {
                games = await this.searchByName(query, cc, lang);
            }

            if (games.length > 0) {
                await this.displaySearchResults(games, gamesGrid, query);
            } else {
                this.displayNoResults(gamesGrid, query);
            }

        } catch (error) {
            console.error('Search error:', error);
            this.displaySearchError(gamesGrid, error);
        } finally {
            this.hideLoading();
        }
    }

    async searchByAppId(appId, cc, lang) {
        try {
            const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&cc=${cc}&l=${lang}`;
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const data = await response.json();
            const gameData = data[appId]?.data;

            if (!gameData || !gameData.name) {
                throw new Error(this.translate('game_not_found'));
            }

            console.log(`AppID ${appId} için Steam API yanıtı:`, {
                name: gameData.name,
                type: gameData.type,
                typeExists: !!gameData.type,
                isDLC: gameData.type === 'dlc',
                allKeys: Object.keys(gameData)
            });

            if (gameData.type === 'dlc') {
                console.log(`AppID ${appId} DLC olarak tespit edildi, gösterilmiyor:`, gameData.name);
                throw new Error(this.translate('dlc_not_supported'));
            }

            if (gameData.categories && Array.isArray(gameData.categories)) {
                const isDLC = gameData.categories.some(cat => 
                    cat.description && cat.description.toLowerCase().includes('downloadable content')
                );
                if (isDLC) {
                    console.log(`AppID ${appId} DLC kategorisi ile tespit edildi, gösterilmiyor:`, gameData.name);
                    throw new Error(this.translate('dlc_not_supported'));
                }
            }

            if (gameData.type && gameData.type !== 'game' && gameData.type !== 'dlc') {
                console.log(`AppID ${appId} bilinmeyen type ile tespit edildi:`, gameData.type, gameData.name);
            }

            const headerImage = await this.getSharedHeader(appId);
            return [{
                appid: appId,
                name: gameData.name,
                type: gameData.type || 'game',
                header_image: headerImage,
                price: gameData.price_overview ? gameData.price_overview.final : 0,
                price_overview: gameData.price_overview,
                discount_percent: gameData.price_overview ? gameData.price_overview.discount_percent : 0,
                platforms: gameData.platforms || {},
                coming_soon: gameData.release_date?.coming_soon || false,
                short_description: gameData.short_description || '',
                reviews: gameData.recommendations ? this.translate('very_positive') : '',
                metacritic: gameData.metacritic,
                release_date: gameData.release_date,
                genres: gameData.genres || [],
                tags: [],
                is_dlc: false
            }];

        } catch (error) {
            console.error(`AppID search error for ${appId}:`, error);
            throw new Error(this.translate('appid_search_failed'));
        }
    }

    async searchByName(query, cc, lang) {
        try {
            const searchTerm = encodeURIComponent(query);
            const resultsUrl = `https://store.steampowered.com/search/results?term=${searchTerm}&force_infinite=1&supportedlang=turkish&ndl=1&snr=1_7_7_151_7&start=0&count=50`;
            
            const response = await fetch(resultsUrl, {
                method: 'GET',
                headers: {
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }

            const html = await response.text();
            const parser = new DOMParser();
            const doc = parser.parseFromString(html, 'text/html');
            const rows = doc.querySelectorAll('.search_result_row');

            if (rows.length === 0) {
                return [];
            }

            const limitedRows = Array.from(rows).slice(0, 20);
            
            const games = await Promise.allSettled(
                limitedRows.map(async (row, index) => {
                    try {
                        const appid = row.getAttribute('data-ds-appid');
                        const name = row.querySelector('.title')?.textContent?.trim() || '';
                        
                        if (!appid || !name) return null;

                        const priceInfo = this.extractPriceInfo(row);
                        
                        const gameDetails = await this.fetchGameDetails(appid, cc, lang);
                        
                        if (gameDetails) {
                            console.log(`AppID ${appid} için fetchGameDetails yanıtı:`, {
                                name: gameDetails.name || name,
                                type: gameDetails.type,
                                typeExists: !!gameDetails.type,
                                isDLC: gameDetails.type === 'dlc',
                                allKeys: Object.keys(gameDetails)
                            });
                        }
                        
                        if (gameDetails && gameDetails.type === 'dlc') {
                            console.log(`AppID ${appid} DLC olarak tespit edildi, gösterilmiyor:`, gameDetails.name || name);
                            return null; // DLC'yi filtrele
                        }

                        if (gameDetails && gameDetails.categories && Array.isArray(gameDetails.categories)) {
                            const isDLC = gameDetails.categories.some(cat => 
                                cat.description && cat.description.toLowerCase().includes('downloadable content')
                            );
                            if (isDLC) {
                                console.log(`AppID ${appid} DLC kategorisi ile tespit edildi, gösterilmiyor:`, gameDetails.name || name);
                                return null; // DLC'yi filtrele
                            }
                        }
                        
                        const headerImage = await this.getSharedHeader(appid);
                        return {
                            appid,
                            name: gameDetails.name || name,
                            type: gameDetails.type || 'game',
                            header_image: headerImage,
                            price: gameDetails.price || priceInfo.price,
                            price_overview: gameDetails.price_overview,
                            discount_percent: gameDetails.discount_percent || priceInfo.discount_percent,
                            platforms: gameDetails.platforms || {},
                            coming_soon: gameDetails.coming_soon || false,
                            short_description: gameDetails.short_description || '',
                            reviews: gameDetails.reviews || '',
                            metacritic: gameDetails.metacritic,
                            release_date: gameDetails.release_date,
                            genres: gameDetails.genres || [],
                            tags: [],
                            is_dlc: false
                        };

                    } catch (error) {
                        console.warn(`Error processing game ${index}:`, error);
                        return null;
                    }
                })
            );

            return games
                .filter(result => result.status === 'fulfilled' && result.value)
                .map(result => result.value);

        } catch (error) {
            console.error('Name search error:', error);
            throw new Error(this.translate('name_search_failed'));
        }
    }

    extractPriceInfo(row) {
        const priceEl = row.querySelector('.search_price');
        let price = 0;
        let discount_percent = 0;

        if (priceEl) {
            const priceText = priceEl.textContent.replace(/\n/g, '').replace(/\s+/g, ' ').trim();
            
            const tlMatch = priceText.match(/([\d,.]+)\s*TL/);
            if (tlMatch) {
                price = parseFloat(tlMatch[1].replace(',', '.')) * 100;
            }
            
            const discountEl = row.querySelector('.search_discount span');
            if (discountEl) {
                const discountText = discountEl.textContent.replace(/[^\d-]/g, '');
                discount_percent = parseInt(discountText) || 0;
            }
        }

        return { price, discount_percent };
    }

    getCachedGameData(appid) {
        const cached = this.steamApiCache.get(appid);
        if (cached && (Date.now() - cached.timestamp) < this.steamApiCacheExpiry) {
            return cached.data;
        }
        return null;
    }

    setCachedGameData(appid, data) {
        this.steamApiCache.set(appid, {
            data: data,
            timestamp: Date.now()
        });
    }

    async fetchGameDetails(appid, cc, lang) {
        try {
            console.log('Renderer: fetchGameDetails çağrıldı, appid:', appid, 'cc:', cc, 'lang:', lang);
            
            const cachedData = this.getCachedGameData(appid);
            if (cachedData) {
                console.log('Renderer: Cache hit, oyun verisi cache\'den alındı:', cachedData.name);
                return cachedData;
            }
            
            const url = `https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&l=${lang}`;
            console.log('Renderer: Steam API URL:', url);
            
            const response = await fetch(url);
            console.log('Renderer: Steam API yanıtı alındı, status:', response.status);
            
            if (response.ok) {
                const data = await response.json();
                if (data && data[appid] && data[appid].success) {
                    const gameData = data[appid].data;
                    console.log('Renderer: Oyun detayları alındı:', gameData.name);
                    
                    const formattedGame = {
                        appid: appid,
                        name: gameData.name || `Game ${appid}`,
                        type: gameData.type || 'game', // Type alanını ekle
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
                    
                    this.setCachedGameData(appid, formattedGame);
                    
                    return formattedGame;
                } else {
                    console.error('Renderer: Steam API\'den oyun detayları alınamadı');
                    return null;
                }
            } else {
                console.error('Renderer: Steam API yanıtı başarısız, status:', response.status);
                return null;
            }
        } catch (error) {
            console.error('Renderer: fetchGameDetails hatası:', error.message);
            return null;
        }
    }

    async displaySearchResults(games, gamesGrid, query) {
        gamesGrid.innerHTML = '';
        
        const searchHeader = document.createElement('div');
        searchHeader.className = 'search-results-header';
        searchHeader.innerHTML = `
            <h2>${this.translate('search_results_for')} "${query}"</h2>
            <span class="results-count">${games.length} ${this.translate('games_found')}</span>
        `;
        gamesGrid.appendChild(searchHeader);

        for (const game of games) {
            try {
                const gameCard = await this.createGameCard(game);
                if (gameCard && gameCard.nodeType === Node.ELEMENT_NODE) {
                    gamesGrid.appendChild(gameCard);
                } else {
                    console.warn('Invalid game card for game:', game);
                }
            } catch (error) {
                console.error('Error creating game card:', error);
            }
        }
    }

    displayNoResults(gamesGrid, query) {
        gamesGrid.innerHTML = `
            <div class="no-search-results">
                <div class="no-results-icon">🔍</div>
                <h3>${this.translate('no_games_found')}</h3>
                <p>${this.translate('no_games_found_for')} "${query}"</p>
                <div class="search-suggestions">
                    <h4>${this.translate('search_suggestions')}:</h4>
                    <ul>
                        <li>${this.translate('check_spelling')}</li>
                        <li>${this.translate('try_different_keywords')}</li>
                        <li>${this.translate('use_steam_app_id')}</li>
                    </ul>
                </div>
            </div>
        `;
    }

    displaySearchError(gamesGrid, error) {
        gamesGrid.innerHTML = `
            <div class="search-error">
                <div class="error-icon">⚠️</div>
                <h3>${this.translate('search_error')}</h3>
                <p>${error.message || this.translate('unknown_search_error')}</p>
                <button class="retry-btn" onclick="ui.retrySearch()">${this.translate('retry_search')}</button>
            </div>
        `;
    }

    addSearchBackButton(gamesGrid, heroSection) {
        let backBtn = document.getElementById('searchBackBtn');
        if (!backBtn) {
            backBtn = document.createElement('button');
            backBtn.id = 'searchBackBtn';
            backBtn.className = 'back-btn search-back-btn';
            backBtn.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M19 12H5M12 19l-7-7 7-7"/>
                </svg>
                <span>${this.translate('go_back')}</span>
            `;
            backBtn.onclick = () => {
                this.loadGames();
                if (heroSection) heroSection.style.display = '';
                this.removeSearchBackButton();
            };
            
            gamesGrid.parentNode.insertBefore(backBtn, gamesGrid);
        }
    }

    retrySearch() {
        const searchInput = document.getElementById('searchInput');
        if (searchInput && searchInput.value.trim()) {
            this.handleSearch(searchInput.value.trim(), true);
        }
    }

    getSelectedLang() {
        const localLang = localStorage.getItem('selectedLang');
        if (localLang) {
            return localLang;
        }
        if (this.config?.selectedLang) {
            return this.config.selectedLang;
        }
        return 'tr';
    }
    getNumberLocale() {
        try {
            const lang = (this.getSelectedLang() || '').toLowerCase();
            const map = {
                'tr': 'tr-TR',
                'en': 'en-US',
                'de': 'de-DE',
                'fr': 'fr-FR',
                'es': 'es-ES',
                'ru': 'ru-RU',
                'zh': 'zh-CN',
                'ja': 'ja-JP',
                'it': 'it-IT',
                'pt': 'pt-PT',
                'pt-br': 'pt-BR',
                'ko': 'ko-KR',
                'ar': 'ar-EG',
                'az': 'az-Latn-AZ',
                'pl': 'pl-PL'
            };
            return map[lang] || 'en-US';
        } catch {
            return 'en-US';
        }
    }
    formatPriceNumber(value) {
        try {
            return Number(value).toLocaleString(this.getNumberLocale(), {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2
            });
        } catch {
            try { return Number(value).toFixed(2); } catch { return String(value); }
        }
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
            
            'game_id': {
                tr: 'Oyun ID', en: 'Game ID', de: 'Spiel-ID', fr: 'ID du jeu', es: 'ID del juego', ru: 'ID игры', zh: '游戏ID', ja: 'ゲームID', it: 'ID gioco', pt: 'ID do jogo', ko: '게임 ID', ar: 'معرف اللعبة', az: 'Oyun ID'
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
            
            'quick_themes': {
                tr: 'Hızlı Temalar:', en: 'Quick Themes:', de: 'Schnelle Themen:', fr: 'Thèmes rapides:', es: 'Temas rápidos:', ru: 'Быстрые темы:', zh: '快速主题:', ja: 'クイックテーマ:', it: 'Temi rapidi:', pt: 'Temas rápidos:', ko: '빠른 테마:', ar: 'السمات السريعة:', az: 'Sürətli Temalar:'
            },
            'custom_settings': {
                tr: 'Özel Ayarlar', en: 'Custom Settings', de: 'Benutzerdefinierte Einstellungen', fr: 'Paramètres personnalisés', es: 'Configuración personalizada', ru: 'Пользовательские настройки', zh: '自定义设置', ja: 'カスタム設定', it: 'Impostazioni personalizzate', pt: 'Configurações personalizadas', ko: '사용자 정의 설정', ar: 'إعدادات مخصصة', az: 'Xüsusi Parametrlər'
            },
            'modern_blue': {
                tr: 'Modern Mavi', en: 'Modern Blue', de: 'Modernes Blau', fr: 'Bleu moderne', es: 'Azul moderno', ru: 'Современный синий', zh: '现代蓝色', ja: 'モダンブルー', it: 'Blu moderno', pt: 'Azul moderno', ko: '모던 블루', ar: 'أزرق حديث', az: 'Modern Mavi'
            },
            'neon_green': {
                tr: 'Neon Yeşil', en: 'Neon Green', de: 'Neongrün', fr: 'Vert néon', es: 'Verde neón', ru: 'Неоновый зеленый', zh: '霓虹绿', ja: 'ネオングリーン', it: 'Verde neon', pt: 'Verde neon', ko: '네온 그린', ar: 'أخضر نيون', az: 'Neon Yaşıl'
            },
            'glass_purple': {
                tr: 'Cam Mor', en: 'Glass Purple', de: 'Glaslila', fr: 'Violet verre', es: 'Púrpura cristal', ru: 'Стеклянный фиолетовый', zh: '玻璃紫', ja: 'ガラスパープル', it: 'Viola vetro', pt: 'Roxo vidro', ko: '글래스 퍼플', ar: 'أرجواني زجاجي', az: 'Şüşə Bənövşəyi'
            },
            'minimal_dark': {
                tr: 'Minimal Koyu', en: 'Minimal Dark', de: 'Minimales Dunkel', fr: 'Sombre minimal', es: 'Oscuro minimal', ru: 'Минималистичный темный', zh: '极简深色', ja: 'ミニマルダーク', it: 'Scuro minimal', pt: 'Escuro minimal', ko: '미니멀 다크', ar: 'داكن بسيط', az: 'Minimal Tünd'
            },
            'retro_orange': {
                tr: 'Retro Turuncu', en: 'Retro Orange', de: 'Retro-Orange', fr: 'Orange rétro', es: 'Naranja retro', ru: 'Ретро оранжевый', zh: '复古橙色', ja: 'レトロオレンジ', it: 'Arancione retro', pt: 'Laranja retro', ko: '레트로 오렌지', ar: 'برتقالي كلاسيكي', az: 'Retro Narıncı'
            },
            'notification_settings': {
                tr: 'Bildirim Ayarları', en: 'Notification Settings', de: 'Benachrichtigungseinstellungen', fr: 'Paramètres de notification', es: 'Configuración de notificaciones', ru: 'Настройки уведомлений', zh: '通知设置', ja: '通知設定', it: 'Impostazioni notifiche', pt: 'Configurações de notificação', ko: '알림 설정', ar: 'إعدادات الإشعارات', az: 'Bildiriş Parametrləri'
            },
            'sound_volume': {
                tr: 'Ses Seviyesi', en: 'Sound Volume', de: 'Lautstärke', fr: 'Volume du son', es: 'Volumen del sonido', ru: 'Громкость звука', zh: '音量', ja: '音量', it: 'Volume audio', pt: 'Volume do som', ko: '소리 볼륨', ar: 'مستوى الصوت', az: 'Səs Səviyyəsi'
            },
            'notification_duration': {
                tr: 'Bildirim Süresi', en: 'Notification Duration', de: 'Benachrichtigungsdauer', fr: 'Durée de notification', es: 'Duración de notificación', ru: 'Длительность уведомления', zh: '通知持续时间', ja: '通知時間', it: 'Durata notifica', pt: 'Duração da notificação', ko: '알림 지속 시간', ar: 'مدة الإشعار', az: 'Bildiriş Müddəti'
            },
            'seconds': {
                tr: 'saniye', en: 'seconds', de: 'Sekunden', fr: 'secondes', es: 'segundos', ru: 'секунд', zh: '秒', ja: '秒', it: 'secondi', pt: 'segundos', ko: '초', ar: 'ثواني', az: 'saniyə'
            },
            'animation': {
                tr: 'Animasyon', en: 'Animation', de: 'Animation', fr: 'Animation', es: 'Animación', ru: 'Анимация', zh: '动画', ja: 'アニメーション', it: 'Animazione', pt: 'Animação', ko: '애니메이션', ar: 'الرسوم المتحركة', az: 'Animasiya'
            },
            'bounce': {
                tr: 'Zıplama', en: 'Bounce', de: 'Springen', fr: 'Rebond', es: 'Rebote', ru: 'Прыжок', zh: '弹跳', ja: 'バウンス', it: 'Rimbalzo', pt: 'Saltar', ko: '바운스', ar: 'ارتداد', az: 'Sıçrayış'
            },
            'scale': {
                tr: 'Büyütme', en: 'Scale', de: 'Skalierung', fr: 'Échelle', es: 'Escala', ru: 'Масштаб', zh: '缩放', ja: 'スケール', it: 'Scala', pt: 'Escala', ko: '크기 조정', ar: 'تحجيم', az: 'Miqyas'
            },
            'notification_style': {
                tr: 'Bildirim Stili', en: 'Notification Style', de: 'Benachrichtigungsstil', fr: 'Style de notification', es: 'Estilo de notificación', ru: 'Стиль уведомления', zh: '通知样式', ja: '通知スタイル', it: 'Stile notifica', pt: 'Estilo da notificação', ko: '알림 스타일', ar: 'نمط الإشعار', az: 'Bildiriş Stili'
            },
            'modern': {
                tr: 'Modern', en: 'Modern', de: 'Modern', fr: 'Moderne', es: 'Moderno', ru: 'Современный', zh: '现代', ja: 'モダン', it: 'Moderno', pt: 'Moderno', ko: '모던', ar: 'حديث', az: 'Modern'
            },
            'glass': {
                tr: 'Cam Efekti', en: 'Glass Effect', de: 'Glaseffekt', fr: 'Effet verre', es: 'Efecto cristal', ru: 'Стеклянный эффект', zh: '玻璃效果', ja: 'ガラス効果', it: 'Effetto vetro', pt: 'Efeito vidro', ko: '글래스 효과', ar: 'تأثير زجاجي', az: 'Şüşə Effekti'
            },
            'neon': {
                tr: 'Neon', en: 'Neon', de: 'Neon', fr: 'Néon', es: 'Neón', ru: 'Неон', zh: '霓虹', ja: 'ネオン', it: 'Neon', pt: 'Neon', ko: '네온', ar: 'نيون', az: 'Neon'
            },
            'cartoon': {
                tr: 'Cartoon', en: 'Cartoon', de: 'Cartoon', fr: 'Cartoon', es: 'Caricatura', ru: 'Мультфильм', zh: '卡通', ja: 'カートゥーン', it: 'Cartoon', pt: 'Desenho', ko: '카툰', ar: 'كرتون', az: 'Cizgi film'
            },
            
            'login_success': {
                tr: 'Giriş başarılı!', en: 'Login successful!', de: 'Anmeldung erfolgreich!', fr: 'Connexion réussie !', es: '¡Inicio de sesión exitoso!', ru: 'Вход выполнен успешно!', zh: '登录成功！', ja: 'ログイン成功！', it: 'Accesso riuscito!', pt: 'Login bem-sucedido!', ko: '로그인 성공!', ar: 'تسجيل الدخول ناجح!', az: 'Giriş uğurlu!'
            },
            'welcome_message': {
                tr: 'Hoş geldiniz!', en: 'Welcome!', de: 'Willkommen!', fr: 'Bienvenue !', es: '¡Bienvenido!', ru: 'Добро пожаловать!', zh: '欢迎！', ja: 'ようこそ！', it: 'Benvenuto!', pt: 'Bem-vindo!', ko: '환영합니다!', ar: 'مرحباً!', az: 'Xoş gəlmisiniz!'
            },
            'logout_success': {
                tr: 'Çıkış yapıldı', en: 'Logged out', de: 'Abgemeldet', fr: 'Déconnecté', es: 'Cerró sesión', ru: 'Выполнен выход', zh: '已登出', ja: 'ログアウトしました', it: 'Disconnesso', pt: 'Desconectado', ko: '로그아웃됨', ar: 'تم تسجيل الخروج', az: 'Çıxış edildi'
            },
            'logout_message': {
                tr: 'Güvenli çıkış yapıldı', en: 'Secure logout completed', de: 'Sichere Abmeldung abgeschlossen', fr: 'Déconnexion sécurisée terminée', es: 'Cierre de sesión seguro completado', ru: 'Безопасный выход выполнен', zh: '安全登出完成', ja: 'セキュアログアウト完了', it: 'Disconnessione sicura completata', pt: 'Logout seguro concluído', ko: '보안 로그아웃 완료', ar: 'تم تسجيل الخروج الآمن', az: 'Təhlükəsiz çıxış tamamlandı'
            },
            
            // Steam Setup ve hid.dll çevirileri
            'steam_path_required': {
                tr: 'Steam Klasörü Bulunamadı', en: 'Steam Folder Not Found', de: 'Steam-Ordner nicht gefunden', fr: 'Dossier Steam introuvable', es: 'Carpeta de Steam no encontrada', ru: 'Папка Steam не найдена', zh: '未找到Steam文件夹', ja: 'Steamフォルダが見つかりません', it: 'Cartella Steam non trovata', pt: 'Pasta Steam não encontrada', ko: 'Steam 폴더를 찾을 수 없음', ar: 'مجلد Steam غير موجود', az: 'Steam qovluğu tapılmadı'
            },
            'steam_path_not_set': {
                tr: 'Steam klasörü bulunamadı. Lütfen Steam\'in kurulu olduğu klasörü seçin.', en: 'Steam folder not found. Please select the folder where Steam is installed.', de: 'Steam-Ordner nicht gefunden. Bitte wählen Sie den Ordner aus, in dem Steam installiert ist.', fr: 'Dossier Steam introuvable. Veuillez sélectionner le dossier où Steam est installé.', es: 'Carpeta de Steam no encontrada. Por favor seleccione la carpeta donde está instalado Steam.', ru: 'Папка Steam не найдена. Пожалуйста, выберите папку, где установлен Steam.', zh: '未找到Steam文件夹。请选择Steam安装的文件夹。', ja: 'Steamフォルダが見つかりません。Steamがインストールされているフォルダを選択してください。', it: 'Cartella Steam non trovata. Seleziona la cartella dove è installato Steam.', pt: 'Pasta Steam não encontrada. Por favor selecione a pasta onde o Steam está instalado.', ko: 'Steam 폴더를 찾을 수 없습니다. Steam이 설치된 폴더를 선택하세요.', ar: 'مجلد Steam غير موجود. يرجى تحديد المجلد حيث تم تثبيت Steam.', az: 'Steam qovluğu tapılmadı. Zəhmət olmasa Steam-in quraşdırıldığı qovluğu seçin.'
            },
            'select_steam_path': {
                tr: 'Steam Klasörü Seç', en: 'Select Steam Folder', de: 'Steam-Ordner auswählen', fr: 'Sélectionner le dossier Steam', es: 'Seleccionar carpeta de Steam', ru: 'Выбрать папку Steam', zh: '选择Steam文件夹', ja: 'Steamフォルダを選択', it: 'Seleziona cartella Steam', pt: 'Selecionar pasta Steam', ko: 'Steam 폴더 선택', ar: 'اختر مجلد Steam', az: 'Steam Qovluğunu Seç'
            },
            'hid_dll_missing': {
                tr: 'hid.dll Bulunamadı', en: 'hid.dll Missing', de: 'hid.dll fehlt', fr: 'hid.dll manquant', es: 'hid.dll faltante', ru: 'hid.dll отсутствует', zh: '缺少hid.dll', ja: 'hid.dllが見つかりません', it: 'hid.dll mancante', pt: 'hid.dll em falta', ko: 'hid.dll 누락', ar: 'hid.dll مفقود', az: 'hid.dll tapılmadı'
            },
            'hid_dll_not_found_description': {
                tr: 'hid.dll dosyası Steam klasöründe bulunamadı. Bu dosya oyunların çalışması için gereklidir.', en: 'hid.dll file not found in Steam folder. This file is required for games to work.', de: 'hid.dll-Datei im Steam-Ordner nicht gefunden. Diese Datei wird für die Funktionalität von Spielen benötigt.', fr: 'Fichier hid.dll introuvable dans le dossier Steam. Ce fichier est nécessaire au fonctionnement des jeux.', es: 'Archivo hid.dll no encontrado en la carpeta de Steam. Este archivo es necesario para que los juegos funcionen.', ru: 'Файл hid.dll не найден в папке Steam. Этот файл необходим для работы игр.', zh: '在Steam文件夹中未找到hid.dll文件。此文件是游戏运行所必需的。', ja: 'Steamフォルダでhid.dllファイルが見つかりません。このファイルはゲームの動作に必要です。', it: 'File hid.dll non trovato nella cartella Steam. Questo file è necessario per il funzionamento dei giochi.', pt: 'Arquivo hid.dll não encontrado na pasta Steam. Este arquivo é necessário para os jogos funcionarem.', ko: 'Steam 폴더에서 hid.dll 파일을 찾을 수 없습니다. 이 파일은 게임 작동에 필요합니다.', ar: 'ملف hid.dll غير موجود في مجلد Steam. هذا الملف مطلوب لكي تعمل الألعاب.', az: 'hid.dll faylı Steam qovluğunda tapılmadı. Bu fayl oyunların işləməsi üçün lazımdır.'
            },
            'important_note': {
                tr: 'ÖNEMLİ NOT', en: 'IMPORTANT NOTE', de: 'WICHTIGER HINWEIS', fr: 'NOTE IMPORTANTE', es: 'NOTA IMPORTANTE', ru: 'ВАЖНОЕ ПРИМЕЧАНИЕ', zh: '重要提示', ja: '重要な注意', it: 'NOTA IMPORTANTE', pt: 'NOTA IMPORTANTE', ko: '중요한 참고사항', ar: 'ملاحظة مهمة', az: 'ƏHƏMİYYƏTLİ QEYD'
            },
            'hid_dll_source_info': {
                tr: 'hid.dll dosyasını Steam Tools\'dan alıyoruz ve sorumluluk kabul etmiyoruz.', en: 'We get the hid.dll file from Steam Tools and we do not accept responsibility.', de: 'Wir beziehen die hid.dll-Datei von Steam Tools und übernehmen keine Verantwortung.', fr: 'Nous obtenons le fichier hid.dll depuis Steam Tools et nous n\'acceptons aucune responsabilité.', es: 'Obtenemos el archivo hid.dll de Steam Tools y no aceptamos responsabilidad.', ru: 'Мы получаем файл hid.dll из Steam Tools и не принимаем на себя ответственность.', zh: '我们从Steam Tools获取hid.dll文件，我们不承担任何责任。', ja: 'hid.dllファイルをSteam Toolsから取得しており、責任は負いません。', it: 'Otteniamo il file hid.dll da Steam Tools e non accettiamo responsabilità.', pt: 'Obtemos o arquivo hid.dll do Steam Tools e não aceitamos responsabilidade.', ko: 'hid.dll 파일을 Steam Tools에서 가져오며 책임을 지지 않습니다.', ar: 'نحصل على ملف hid.dll من Steam Tools ولا نقبل المسؤولية.', az: 'hid.dll faylını Steam Tools-dan alırıq və məsuliyyət qəbul etmirik.'
            },
            'hid_dll_required_for_games': {
                tr: 'Steam kütüphanesinde oyun gözükmesi için gereklidir.', en: 'Required for games to appear in Steam library.', de: 'Erforderlich, damit Spiele in der Steam-Bibliothek angezeigt werden.', fr: 'Nécessaire pour que les jeux apparaissent dans la bibliothèque Steam.', es: 'Necesario para que los juegos aparezcan en la biblioteca de Steam.', ru: 'Необходимо для отображения игр в библиотеке Steam.', zh: '游戏在Steam库中显示所必需的。', ja: 'Steamライブラリでゲームを表示するために必要です。', it: 'Necessario per far apparire i giochi nella libreria Steam.', pt: 'Necessário para que os jogos apareçam na biblioteca Steam.', ko: '게임이 Steam 라이브러리에 표시되기 위해 필요합니다.', ar: 'مطلوب لكي تظهر الألعاب في مكتبة Steam.', az: 'Oyunların Steam kitabxanasında görünməsi üçün lazımdır.'
            },
            'hid_dll_manual_option': {
                tr: 'İsterseniz kendiniz de hid.dll dosyasını Steam klasörüne atabilirsiniz.', en: 'If you want, you can also manually place the hid.dll file in the Steam folder.', de: 'Wenn Sie möchten, können Sie die hid.dll-Datei auch manuell in den Steam-Ordner legen.', fr: 'Si vous le souhaitez, vous pouvez également placer manuellement le fichier hid.dll dans le dossier Steam.', es: 'Si lo desea, también puede colocar manualmente el archivo hid.dll en la carpeta de Steam.', ru: 'Если хотите, вы также можете вручную поместить файл hid.dll в папку Steam.', zh: '如果您愿意，您也可以手动将hid.dll文件放在Steam文件夹中。', ja: 'ご希望であれば、hid.dllファイルを手動でSteamフォルダに配置することもできます。', it: 'Se vuoi, puoi anche posizionare manualmente il file hid.dll nella cartella Steam.', pt: 'Se quiser, você também pode colocar manualmente o arquivo hid.dll na pasta Steam.', ko: '원한다면 hid.dll 파일을 Steam 폴더에 수동으로 배치할 수도 있습니다.', ar: 'إذا أردت، يمكنك أيضًا وضع ملف hid.dll يدويًا في مجلد Steam.', az: 'İstəsəniz, hid.dll faylını özünüz də Steam qovluğuna ata bilərsiniz.'
            },
            'download_hid_dll': {
                tr: 'hid.dll İndir', en: 'Download hid.dll', de: 'hid.dll herunterladen', fr: 'Télécharger hid.dll', es: 'Descargar hid.dll', ru: 'Скачать hid.dll', zh: '下载hid.dll', ja: 'hid.dllをダウンロード', it: 'Scarica hid.dll', pt: 'Baixar hid.dll', ko: 'hid.dll 다운로드', ar: 'تحميل hid.dll', az: 'hid.dll Endir'
            },
            'close_program': {
                tr: 'Programı Kapat', en: 'Close Program', de: 'Programm schließen', fr: 'Fermer le programme', es: 'Cerrar programa', ru: 'Закрыть программу', zh: '关闭程序', ja: 'プログラムを閉じる', it: 'Chiudi programma', pt: 'Fechar programa', ko: '프로그램 닫기', ar: 'إغلاق البرنامج', az: 'Proqramı Bağla'
            },
            
            'active': {
                tr: 'aktif', en: 'active', de: 'aktiv', fr: 'actif', es: 'activo', ru: 'активен', zh: '活跃', ja: 'アクティブ', it: 'attivo', pt: 'ativo', ko: '활성', ar: 'نشط', az: 'aktiv'
            },
            'search_placeholder': {
                tr: 'Oyun ara...', en: 'Search games...', de: 'Spiele suchen...', fr: 'Rechercher des jeux...', es: 'Buscar juegos...', ru: 'Поиск игр...', zh: '搜索游戏...', ja: 'ゲームを検索...', it: 'Cerca giochi...', pt: 'Pesquisar jogos...', ko: '게임 검색...', ar: 'البحث عن الألعاب...', az: 'Oyun axtar...'
            },
            'home': {
                tr: 'Ana Sayfa', en: 'Home', de: 'Startseite', fr: 'Accueil', es: 'Inicio', ru: 'Главная', zh: '首页', ja: 'ホーム', it: 'Home', pt: 'Início', ko: '홈', ar: 'الرئيسية', az: 'Ana Səhifə'
            },
            'repair_fix': {
                tr: 'Çevrimiçi Düzeltme', en: 'Online Fix', de: 'Online-Reparatur', fr: 'Correction en ligne', es: 'Corrección en línea', ru: 'Онлайн исправление', zh: '在线修复', ja: 'オンライン修正', it: 'Correzione online', pt: 'Correção online', ko: '온라인 수정', ar: 'التصحيح عبر الإنترنت', az: 'Onlayn Düzəliş'
            },
            'bypass': {
                tr: 'Bypass', en: 'Bypass', de: 'Bypass', fr: 'Bypass', es: 'Bypass', ru: 'Обход', zh: '绕过', ja: 'バイパス', it: 'Bypass', pt: 'Bypass', ko: '우회', ar: 'تجاوز', az: 'Bypass'
            },
            'library': {
                tr: 'Kütüphanem', en: 'My Library', de: 'Meine Bibliothek', fr: 'Ma bibliothèque', es: 'Mi biblioteca', ru: 'Моя библиотека', zh: '我的库', ja: 'マイライブラリ', it: 'La mia libreria', pt: 'Minha biblioteca', ko: '내 라이브러리', ar: 'مكتبتي', az: 'Kitabxanam'
            },
            'manual_install': {
                tr: 'Manuel Kurulum', en: 'Manual Install', de: 'Manuelle Installation', fr: 'Installation manuelle', es: 'Instalación manual', ru: 'Ручная установка', zh: '手动安装', ja: '手動インストール', it: 'Installazione manuale', pt: 'Instalação manual', ko: '수동 설치', ar: 'التثبيت اليدوي', az: 'Manual Quraşdırma'
            },
            'settings': {
                tr: 'Ayarlar', en: 'Settings', de: 'Einstellungen', fr: 'Paramètres', es: 'Configuración', ru: 'Настройки', zh: '设置', ja: '設定', it: 'Impostazioni', pt: 'Configurações', ko: '설정', ar: 'الإعدادات', az: 'Parametrlər'
            },
            
            'paradise_steam_library': {
                tr: 'Paradise Steam Library', en: 'Paradise Steam Library', de: 'Paradise Steam Library', fr: 'Paradise Steam Library', es: 'Paradise Steam Library', ru: 'Paradise Steam Library', zh: 'Paradise Steam Library', ja: 'Paradise Steam Library', it: 'Paradise Steam Library', pt: 'Paradise Steam Library', ko: 'Paradise Steam Library', ar: 'Paradise Steam Library', az: 'Paradise Steam Library'
            },
            'login_to_account': {
                tr: 'Hesabınıza giriş yapın', en: 'Login to your account', de: 'Bei Ihrem Konto anmelden', fr: 'Connectez-vous à votre compte', es: 'Inicia sesión en tu cuenta', ru: 'Войдите в свой аккаунт', zh: '登录您的账户', ja: 'アカウントにログイン', it: 'Accedi al tuo account', pt: 'Faça login na sua conta', ko: '계정에 로그인', ar: 'تسجيل الدخول إلى حسابك', az: 'Hesabınıza daxil olun'
            },
            'discord_login_info': {
                tr: 'Discord hesabınızla giriş yaparak Paradise Steam Library\'ye erişim sağlayın. Güvenli ve hızlı giriş için Discord OAuth2 kullanıyoruz.', en: 'Access Paradise Steam Library by logging in with your Discord account. We use Discord OAuth2 for secure and fast login.', de: 'Greifen Sie auf Paradise Steam Library zu, indem Sie sich mit Ihrem Discord-Konto anmelden. Wir verwenden Discord OAuth2 für sichere und schnelle Anmeldung.', fr: 'Accédez à Paradise Steam Library en vous connectant avec votre compte Discord. Nous utilisons Discord OAuth2 pour une connexion sécurisée et rapide.', es: 'Accede a Paradise Steam Library iniciando sesión con tu cuenta de Discord. Usamos Discord OAuth2 para un inicio de sesión seguro y rápido.', ru: 'Получите доступ к Paradise Steam Library, войдя в систему с помощью вашей учетной записи Discord. Мы используем Discord OAuth2 для безопасного и быстрого входа.', zh: '通过使用您的Discord账户登录来访问Paradise Steam Library。我们使用Discord OAuth2进行安全快速的登录。', ja: 'DiscordアカウントでログインしてParadise Steam Libraryにアクセスします。安全で高速なログインのためにDiscord OAuth2を使用しています。', it: 'Accedi a Paradise Steam Library effettuando l\'accesso con il tuo account Discord. Utilizziamo Discord OAuth2 per un accesso sicuro e veloce.', pt: 'Acesse Paradise Steam Library fazendo login com sua conta Discord. Usamos Discord OAuth2 para login seguro e rápido.', ko: 'Discord 계정으로 로그인하여 Paradise Steam Library에 액세스하세요. 안전하고 빠른 로그인을 위해 Discord OAuth2를 사용합니다.', ar: 'الوصول إلى Paradise Steam Library من خلال تسجيل الدخول بحساب Discord الخاص بك. نستخدم Discord OAuth2 لتسجيل دخول آمن وسريع.', az: 'Discord hesabınızla giriş edərək Paradise Steam Library-yə giriş əldə edin. Təhlükəsiz və sürətli giriş üçün Discord OAuth2 istifadə edirik.'
            },
            'discord_login': {
                tr: 'Discord ile Giriş Yap', en: 'Login with Discord', de: 'Mit Discord anmelden', fr: 'Se connecter avec Discord', es: 'Iniciar sesión con Discord', ru: 'Войти через Discord', zh: '使用Discord登录', ja: 'Discordでログイン', it: 'Accedi con Discord', pt: 'Entrar com Discord', ko: 'Discord로 로그인', ar: 'تسجيل الدخول باستخدام Discord', az: 'Discord ilə Giriş Et'
            },
            'discord_info': {
                tr: 'Discord hesabınız yok mu? <a href="https://discord.com" target="_blank">Discord.com</a> adresinden ücretsiz hesap oluşturabilirsiniz.', en: 'Don\'t have a Discord account? You can create a free account at <a href="https://discord.com" target="_blank">Discord.com</a>.', de: 'Haben Sie kein Discord-Konto? Sie können ein kostenloses Konto bei <a href="https://discord.com" target="_blank">Discord.com</a> erstellen.', fr: 'Vous n\'avez pas de compte Discord ? Vous pouvez créer un compte gratuit sur <a href="https://discord.com" target="_blank">Discord.com</a>.', es: '¿No tienes cuenta de Discord? Puedes crear una cuenta gratuita en <a href="https://discord.com" target="_blank">Discord.com</a>.', ru: 'У вас нет аккаунта Discord? Вы можете создать бесплатный аккаунт на <a href="https://discord.com" target="_blank">Discord.com</a>.', zh: '没有Discord账户？您可以在<a href="https://discord.com" target="_blank">Discord.com</a>创建免费账户。', ja: 'Discordアカウントをお持ちでないですか？<a href="https://discord.com" target="_blank">Discord.com</a>で無料アカウントを作成できます。', it: 'Non hai un account Discord? Puoi creare un account gratuito su <a href="https://discord.com" target="_blank">Discord.com</a>.', pt: 'Não tem conta Discord? Pode criar uma conta gratuita em <a href="https://discord.com" target="_blank">Discord.com</a>.', ko: 'Discord 계정이 없으신가요? <a href="https://discord.com" target="_blank">Discord.com</a>에서 무료 계정을 만들 수 있습니다.', ar: 'ليس لديك حساب Discord؟ يمكنك إنشاء حساب مجاني على <a href="https://discord.com" target="_blank">Discord.com</a>.', az: 'Discord hesabınız yoxdur? <a href="https://discord.com" target="_blank">Discord.com</a> ünvanından pulsuz hesab yarada bilərsiniz.'
            },
            'login_error': {
                tr: 'Giriş bilgileri hatalı', en: 'Login credentials are incorrect', de: 'Anmeldedaten sind falsch', fr: 'Les informations de connexion sont incorrectes', es: 'Las credenciales de inicio de sesión son incorrectas', ru: 'Неверные данные для входа', zh: '登录凭据错误', ja: 'ログイン情報が正しくありません', it: 'Le credenziali di accesso sono errate', pt: 'As credenciais de login estão incorretas', ko: '로그인 자격 증명이 잘못되었습니다', ar: 'بيانات تسجيل الدخول غير صحيحة', az: 'Giriş məlumatları yanlışdır'
            },
            
            'featured_game': {
                tr: 'Öne Çıkan Oyun', en: 'Featured Game', de: 'Empfohlenes Spiel', fr: 'Jeu en vedette', es: 'Juego destacado', ru: 'Рекомендуемая игра', zh: '特色游戏', ja: '注目のゲーム', it: 'Gioco in evidenza', pt: 'Jogo em destaque', ko: '주요 게임', ar: 'لعبة مميزة', az: 'Seçilmiş Oyun'
            },
            'loading': {
                tr: 'Yükleniyor...', en: 'Loading...', de: 'Wird geladen...', fr: 'Chargement...', es: 'Cargando...', ru: 'Загрузка...', zh: '加载中...', ja: '読み込み中...', it: 'Caricamento...', pt: 'Carregando...', ko: '로딩 중...', ar: 'جاري التحميل...', az: 'Yüklənir...'
            },
            'discovering_games': {
                tr: 'Harika oyunlar keşfediliyor...', en: 'Discovering amazing games...', de: 'Erstaunliche Spiele werden entdeckt...', fr: 'Découverte de jeux incroyables...', es: 'Descubriendo juegos increíbles...', ru: 'Открытие удивительных игр...', zh: '发现精彩游戏...', ja: '素晴らしいゲームを発見中...', it: 'Scoprendo giochi incredibili...', pt: 'Descobrindo jogos incríveis...', ko: '놀라운 게임을 발견하는 중...', ar: 'اكتشاف ألعاب مذهلة...', az: 'Əla oyunlar kəşf edilir...'
            },
            'view_details': {
                tr: 'Detayları Görüntüle', en: 'View Details', de: 'Details anzeigen', fr: 'Voir les détails', es: 'Ver detalles', ru: 'Посмотреть детали', zh: '查看详情', ja: '詳細を見る', it: 'Visualizza dettagli', pt: 'Ver detalhes', ko: '상세 보기', ar: 'عرض التفاصيل', az: 'Təfərrüatları Görüntülə'
            },
            'add_to_library': {
                tr: 'Kütüphaneme Ekle', en: 'Add to Library', de: 'Zur Bibliothek hinzufügen', fr: 'Ajouter à la bibliothèque', es: 'Agregar a la biblioteca', ru: 'Добавить в библиотеку', zh: '添加到库', ja: 'ライブラリに追加', it: 'Aggiungi alla libreria', pt: 'Adicionar à biblioteca', ko: '라이브러리에 추가', ar: 'أضف إلى المكتبة', az: 'Kitabxanama Əlavə Et'
            },
            'featured_games': {
                tr: 'Öne Çıkan Oyunlar', en: 'Featured Games', de: 'Empfohlene Spiele', fr: 'Jeux en vedette', es: 'Juegos destacados', ru: 'Рекомендуемые игры', zh: '特色游戏', ja: '注目のゲーム', it: 'Giochi in evidenza', pt: 'Jogos em destaque', ko: '주요 게임', ar: 'ألعاب مميزة', az: 'Seçilmiş Oyunlar'
            },
            
            'library_tab': {
                tr: 'Oyun', en: 'Game', de: 'Spiel', fr: 'Jeu', es: 'Juego', ru: 'Игра', zh: '游戏', ja: 'ゲーム', it: 'Gioco', pt: 'Jogo', ko: '게임', ar: 'لعبة', az: 'Oyun'
            },
            'refresh_library': {
                tr: 'Kütüphaneyi Yenile', en: 'Refresh Library', de: 'Bibliothek aktualisieren', fr: 'Actualiser la bibliothèque', es: 'Actualizar biblioteca', ru: 'Обновить библиотеку', zh: '刷新库', ja: 'ライブラリを更新', it: 'Aggiorna libreria', pt: 'Atualizar biblioteca', ko: '라이브러리 새로고침', ar: 'تحديث المكتبة', az: 'Kitabxananı Yenilə'
            },
            
            'steam_config': {
                tr: 'Steam Yapılandırması', en: 'Steam Configuration', de: 'Steam-Konfiguration', fr: 'Configuration Steam', es: 'Configuración de Steam', ru: 'Конфигурация Steam', zh: 'Steam配置', ja: 'Steam設定', it: 'Configurazione Steam', pt: 'Configuração Steam', ko: 'Steam 구성', ar: 'تكوين Steam', az: 'Steam Konfiqurasiyası'
            },
            'steam_path': {
                tr: 'Steam Kurulum Yolu:', en: 'Steam Installation Path:', de: 'Steam-Installationspfad:', fr: 'Chemin d\'installation Steam :', es: 'Ruta de instalación de Steam:', ru: 'Путь установки Steam:', zh: 'Steam安装路径:', ja: 'Steamインストールパス:', it: 'Percorso di installazione Steam:', pt: 'Caminho de instalação Steam:', ko: 'Steam 설치 경로:', ar: 'مسار تثبيت Steam:', az: 'Steam Quraşdırma Yolu:'
            },
            'steam_path_placeholder': {
                tr: 'Steam kurulum yolu seçin...', en: 'Select Steam installation path...', de: 'Steam-Installationspfad auswählen...', fr: 'Sélectionnez le chemin d\'installation Steam...', es: 'Selecciona la ruta de instalación de Steam...', ru: 'Выберите путь установки Steam...', zh: '选择Steam安装路径...', ja: 'Steamインストールパスを選択...', it: 'Seleziona il percorso di installazione Steam...', pt: 'Selecione o caminho de instalação Steam...', ko: 'Steam 설치 경로를 선택하세요...', ar: 'اختر مسار تثبيت Steam...', az: 'Steam quraşdırma yolunu seçin...'
            },
            'browse': {
                tr: 'Gözat', en: 'Browse', de: 'Durchsuchen', fr: 'Parcourir', es: 'Examinar', ru: 'Обзор', zh: '浏览', ja: '参照', it: 'Sfoglia', pt: 'Procurar', ko: '찾아보기', ar: 'تصفح', az: 'Gözdən Keçir'
            },
            
            'game_title': {
                tr: 'Oyun Adı', en: 'Game Title', de: 'Spieltitel', fr: 'Titre du jeu', es: 'Título del juego', ru: 'Название игры', zh: '游戏标题', ja: 'ゲームタイトル', it: 'Titolo del gioco', pt: 'Título do jogo', ko: '게임 제목', ar: 'عنوان اللعبة', az: 'Oyun Başlığı'
            },
            'developer': {
                tr: 'Geliştirici', en: 'Developer', de: 'Entwickler', fr: 'Développeur', es: 'Desarrollador', ru: 'Разработчик', zh: '开发者', ja: '開発者', it: 'Sviluppatore', pt: 'Desenvolvedor', ko: '개발자', ar: 'المطور', az: 'İnkişafçı'
            },
            'release_year': {
                tr: '2023', en: '2023', de: '2023', fr: '2023', es: '2023', ru: '2023', zh: '2023', ja: '2023', it: '2023', pt: '2023', ko: '2023', ar: '2023', az: '2023'
            },
            'price': {
                tr: 'Fiyat', en: 'Price', de: 'Preis', fr: 'Prix', es: 'Precio', ru: 'Цена', zh: '价格', ja: '価格', it: 'Prezzo', pt: 'Preço', ko: '가격', ar: 'السعر', az: 'Qiymət'
            },
            'reviews': {
                tr: 'İncelemeler', en: 'Reviews', de: 'Bewertungen', fr: 'Avis', es: 'Reseñas', ru: 'Отзывы', zh: '评论', ja: 'レビュー', it: 'Recensioni', pt: 'Avaliações', ko: '리뷰', ar: 'المراجعات', az: 'Rəylər'
            },
            'about_game': {
                tr: 'Bu Oyun Hakkında', en: 'About This Game', de: 'Über dieses Spiel', fr: 'À propos de ce jeu', es: 'Acerca de este juego', ru: 'Об этой игре', zh: '关于这款游戏', ja: 'このゲームについて', it: 'Informazioni su questo gioco', pt: 'Sobre este jogo', ko: '이 게임에 대해', ar: 'حول هذه اللعبة', az: 'Bu Oyun Haqqında'
            },
            'game_description': {
                tr: 'Oyun açıklaması burada yüklenecek...', en: 'Game description will be loaded here...', de: 'Spielbeschreibung wird hier geladen...', fr: 'La description du jeu sera chargée ici...', es: 'La descripción del juego se cargará aquí...', ru: 'Описание игры будет загружено здесь...', zh: '游戏描述将在此处加载...', ja: 'ゲームの説明がここに読み込まれます...', it: 'La descrizione del gioco verrà caricata qui...', pt: 'A descrição do jogo será carregada aqui...', ko: '게임 설명이 여기에 로드됩니다...', ar: 'سيتم تحميل وصف اللعبة هنا...', az: 'Oyun təsviri burada yüklənəcək...'
            },
            'publisher': {
                tr: 'Yayıncı:', en: 'Publisher:', de: 'Herausgeber:', fr: 'Éditeur :', es: 'Editor:', ru: 'Издатель:', zh: '发行商:', ja: 'パブリッシャー:', it: 'Editore:', pt: 'Editora:', ko: '퍼블리셔:', ar: 'الناشر:', az: 'Nəşriyyatçı:'
            },
            'release_date': {
                tr: 'Çıkış Tarihi:', en: 'Release Date:', de: 'Veröffentlichungsdatum:', fr: 'Date de sortie :', es: 'Fecha de lanzamiento:', ru: 'Дата выхода:', zh: '发布日期:', ja: 'リリース日:', it: 'Data di uscita:', pt: 'Data de lançamento:', ko: '출시일:', ar: 'تاريخ الإصدار:', az: 'Çıxış Tarixi:'
            },
            'genres': {
                tr: 'Türler:', en: 'Genres:', de: 'Genres:', fr: 'Genres :', es: 'Géneros:', ru: 'Жанры:', zh: '类型:', ja: 'ジャンル:', it: 'Generi:', pt: 'Gêneros:', ko: '장르:', ar: 'الأنواع:', az: 'Janrlar:'
            },
            'open_in_steam': {
                tr: 'Steam\'de Aç', en: 'Open in Steam', de: 'In Steam öffnen', fr: 'Ouvrir dans Steam', es: 'Abrir en Steam', ru: 'Открыть в Steam', zh: '在Steam中打开', ja: 'Steamで開く', it: 'Apri in Steam', pt: 'Abrir no Steam', ko: 'Steam에서 열기', ar: 'افتح في Steam', az: 'Steam-də Aç'
            },
            'start_game': {
                tr: 'Oyunu Başlat', en: 'Start Game', de: 'Spiel starten', fr: 'Démarrer le jeu', es: 'Iniciar juego', ru: 'Запустить игру', zh: '启动游戏', ja: 'ゲームを開始', it: 'Avvia gioco', pt: 'Iniciar jogo', ko: '게임 시작', ar: 'ابدأ اللعبة', az: 'Oyunu Başlat'
            },
            
            'select_dlcs': {
                tr: 'DLC\'leri Seç', en: 'Select DLCs', de: 'DLCs auswählen', fr: 'Sélectionner les DLCs', es: 'Seleccionar DLCs', ru: 'Выбрать DLC', zh: '选择DLC', ja: 'DLCを選択', it: 'Seleziona DLC', pt: 'Selecionar DLCs', ko: 'DLC 선택', ar: 'اختر DLC', az: 'DLC-ləri Seç'
            },
            'select_all_dlcs': {
                tr: 'Tümünü Seç', en: 'Select All', de: 'Alle auswählen', fr: 'Tout sélectionner', es: 'Seleccionar todo', ru: 'Выбрать все', zh: '全选', ja: 'すべて選択', it: 'Seleziona tutto', pt: 'Selecionar tudo', ko: '모두 선택', ar: 'اختر الكل', az: 'Hamısını Seç'
            },
            'add_selected': {
                tr: 'Seçilenleri Ekle', en: 'Add Selected', de: 'Ausgewählte hinzufügen', fr: 'Ajouter la sélection', es: 'Agregar seleccionados', ru: 'Добавить выбранные', zh: '添加已选', ja: '選択したものを追加', it: 'Aggiungi selezionati', pt: 'Adicionar selecionados', ko: '선택된 항목 추가', ar: 'أضف المحدد', az: 'Seçilənləri Əlavə Et'
            },
            'cancel': {
                tr: 'İptal', en: 'Cancel', de: 'Abbrechen', fr: 'Annuler', es: 'Cancelar', ru: 'Отмена', zh: '取消', ja: 'キャンセル', it: 'Annulla', pt: 'Cancelar', ko: '취소', ar: 'إلغاء', az: 'Ləğv Et'
            },
            
            'restart_steam_title': {
                tr: 'Steam\'i Yeniden Başlat', en: 'Restart Steam', de: 'Steam neu starten', fr: 'Redémarrer Steam', es: 'Reiniciar Steam', ru: 'Перезапустить Steam', zh: '重启Steam', ja: 'Steamを再起動', it: 'Riavvia Steam', pt: 'Reiniciar Steam', ko: 'Steam 재시작', ar: 'إعادة تشغيل Steam', az: 'Steam-i Yenidən Başlat'
            },
            'restart_steam_info': {
                tr: 'Oyun kütüphanenize eklendi! Değişiklikleri görmek için Steam\'in yeniden başlatılması gerekiyor.', en: 'Game added to your library! Steam needs to be restarted to see the changes.', de: 'Spiel zu Ihrer Bibliothek hinzugefügt! Steam muss neu gestartet werden, um die Änderungen zu sehen.', fr: 'Jeu ajouté à votre bibliothèque ! Steam doit être redémarré pour voir les changements.', es: '¡Juego agregado a tu biblioteca! Steam debe reiniciarse para ver los cambios.', ru: 'Игра добавлена в вашу библиотеку! Steam нужно перезапустить, чтобы увидеть изменения.', zh: '游戏已添加到您的库中！需要重启Steam才能看到更改。', ja: 'ゲームがライブラリに追加されました！変更を確認するにはSteamを再起動する必要があります。', it: 'Gioco aggiunto alla tua libreria! Steam deve essere riavviato per vedere le modifiche.', pt: 'Jogo adicionado à sua biblioteca! Steam precisa ser reiniciado para ver as mudanças.', ko: '게임이 라이브러리에 추가되었습니다! 변경사항을 보려면 Steam을 재시작해야 합니다.', ar: 'تمت إضافة اللعبة إلى مكتبتك! يجب إعادة تشغيل Steam لرؤية التغييرات.', az: 'Oyun kitabxananıza əlavə edildi! Dəyişiklikləri görmək üçün Steam-in yenidən başladılması lazımdır.'
            },
            'restart_steam_question': {
                tr: 'Steam\'i şimdi yeniden başlatmak istiyor musunuz?', en: 'Do you want to restart Steam now?', de: 'Möchten Sie Steam jetzt neu starten?', fr: 'Voulez-vous redémarrer Steam maintenant ?', es: '¿Quieres reiniciar Steam ahora?', ru: 'Хотите перезапустить Steam сейчас?', zh: '您想现在重启Steam吗？', ja: '今すぐSteamを再起動しますか？', it: 'Vuoi riavviare Steam ora?', pt: 'Você quer reiniciar Steam agora?', ko: '지금 Steam을 재시작하시겠습니까?', ar: 'هل تريد إعادة تشغيل Steam الآن؟', az: 'Steam-i indi yenidən başlatmaq istəyirsinizmi?'
            },
            'restart_steam_yes': {
                tr: 'Evet, Yeniden Başlat', en: 'Yes, Restart', de: 'Ja, neu starten', fr: 'Oui, redémarrer', es: 'Sí, reiniciar', ru: 'Да, перезапустить', zh: '是，重启', ja: 'はい、再起動', it: 'Sì, riavvia', pt: 'Sim, reiniciar', ko: '예, 재시작', ar: 'نعم، إعادة تشغيل', az: 'Bəli, Yenidən Başlat'
            },
            'restart_steam_no': {
                tr: 'Hayır, Daha Sonra', en: 'No, Later', de: 'Nein, später', fr: 'Non, plus tard', es: 'No, más tarde', ru: 'Нет, позже', zh: '不，稍后', ja: 'いいえ、後で', it: 'No, più tardi', pt: 'Não, mais tarde', ko: '아니요, 나중에', ar: 'لا، لاحقاً', az: 'Xeyr, Daha Sonra'
            },
            
            'notification_settings': {
                tr: 'Bildirim Ayarları', en: 'Notification Settings', de: 'Benachrichtigungseinstellungen', fr: 'Paramètres de notification', es: 'Configuración de notificaciones', ru: 'Настройки уведомлений', zh: '通知设置', ja: '通知設定', it: 'Impostazioni notifiche', pt: 'Configurações de notificação', ko: '알림 설정', ar: 'إعدادات الإشعارات', az: 'Bildiriş Parametrləri'
            },
            'sound_volume': {
                tr: 'Ses Seviyesi', en: 'Sound Volume', de: 'Lautstärke', fr: 'Volume sonore', es: 'Volumen de sonido', ru: 'Громкость звука', zh: '音量', ja: '音量', it: 'Volume audio', pt: 'Volume do som', ko: '소리 볼륨', ar: 'مستوى الصوت', az: 'Səs Səviyyəsi'
            },
            'notification_duration': {
                tr: 'Bildirim Süresi', en: 'Notification Duration', de: 'Benachrichtigungsdauer', fr: 'Durée de notification', es: 'Duración de notificación', ru: 'Длительность уведомления', zh: '通知持续时间', ja: '通知の持続時間', it: 'Durata notifica', pt: 'Duração da notificação', ko: '알림 지속 시간', ar: 'مدة الإشعار', az: 'Bildiriş Müddəti'
            },
            'seconds': {
                tr: 'saniye', en: 'seconds', de: 'Sekunden', fr: 'secondes', es: 'segundos', ru: 'секунд', zh: '秒', ja: '秒', it: 'secondi', pt: 'segundos', ko: '초', ar: 'ثانية', az: 'saniyə'
            },
            'animation': {
                tr: 'Animasyon', en: 'Animation', de: 'Animation', fr: 'Animation', es: 'Animación', ru: 'Анимация', zh: '动画', ja: 'アニメーション', it: 'Animazione', pt: 'Animação', ko: '애니메이션', ar: 'الرسوم المتحركة', az: 'Animasiya'
            },
            'slide': {
                tr: 'Kaydırma', en: 'Slide', de: 'Gleiten', fr: 'Glissement', es: 'Deslizar', ru: 'Скольжение', zh: '滑动', ja: 'スライド', it: 'Scorrimento', pt: 'Deslizar', ko: '슬라이드', ar: 'انزلاق', az: 'Sürüşmə'
            },
            'fade': {
                tr: 'Solma', en: 'Fade', de: 'Verblassen', fr: 'Fondu', es: 'Desvanecer', ru: 'Затухание', zh: '淡入淡出', ja: 'フェード', it: 'Dissolvenza', pt: 'Desvanecer', ko: '페이드', ar: 'تلاشي', az: 'Solma'
            },
            'bounce': {
                tr: 'Zıplama', en: 'Bounce', de: 'Springen', fr: 'Rebond', es: 'Rebote', ru: 'Отскок', zh: '弹跳', ja: 'バウンス', it: 'Rimbalzo', pt: 'Quicar', ko: '바운스', ar: 'ارتداد', az: 'Sıçrama'
            },
            'scale': {
                tr: 'Büyütme', en: 'Scale', de: 'Skalierung', fr: 'Échelle', es: 'Escala', ru: 'Масштабирование', zh: '缩放', ja: 'スケール', it: 'Scala', pt: 'Escala', ko: '스케일', ar: 'قياس', az: 'Ölçü'
            },
            
            'notification_style': {
                tr: 'Bildirim Stili', en: 'Notification Style', de: 'Benachrichtigungsstil', fr: 'Style de notification', es: 'Estilo de notificación', ru: 'Стиль уведомления', zh: '通知样式', ja: '通知スタイル', it: 'Stile notifica', pt: 'Estilo de notificação', ko: '알림 스타일', ar: 'نمط الإشعار', az: 'Bildiriş Stili'
            },
            'modern': {
                tr: 'Modern', en: 'Modern', de: 'Modern', fr: 'Moderne', es: 'Moderno', ru: 'Современный', zh: '现代', ja: 'モダン', it: 'Moderno', pt: 'Moderno', ko: '모던', ar: 'حديث', az: 'Modern'
            },
            'glass': {
                tr: 'Cam', en: 'Glass', de: 'Glas', fr: 'Verre', es: 'Cristal', ru: 'Стекло', zh: '玻璃', ja: 'ガラス', it: 'Vetro', pt: 'Vidro', ko: '글래스', ar: 'زجاج', az: 'Şüşə'
            },
            'neon': {
                tr: 'Neon', en: 'Neon', de: 'Neon', fr: 'Néon', es: 'Neón', ru: 'Неон', zh: '霓虹', ja: 'ネオン', it: 'Neon', pt: 'Neon', ko: '네온', ar: 'نيون', az: 'Neon'
            },
            'cartoon': {
                tr: 'Cartoon', en: 'Cartoon', de: 'Cartoon', fr: 'Cartoon', es: 'Caricatura', ru: 'Мультфильм', zh: '卡通', ja: 'カートゥーン', it: 'Cartoon', pt: 'Cartoon', ko: '만화', ar: 'رسوم متحركة', az: 'Kartun'
            },
            'minimal': {
                tr: 'Minimal', en: 'Minimal', de: 'Minimal', fr: 'Minimal', es: 'Minimal', ru: 'Минимальный', zh: '极简', ja: 'ミニマル', it: 'Minimale', pt: 'Minimal', ko: '미니멀', ar: 'الحد الأدنى', az: 'Minimal'
            },
            'retro': {
                tr: 'Retro', en: 'Retro', de: 'Retro', fr: 'Rétro', es: 'Retro', ru: 'Ретро', zh: '复古', ja: 'レトロ', it: 'Retro', pt: 'Retro', ko: '레트로', ar: 'ريترو', az: 'Retro'
            },
            'cyberpunk': {
                tr: 'Cyberpunk', en: 'Cyberpunk', de: 'Cyberpunk', fr: 'Cyberpunk', es: 'Cyberpunk', ru: 'Киберпанк', zh: '赛博朋克', ja: 'サイバーパンク', it: 'Cyberpunk', pt: 'Cyberpunk', ko: '사이버펑크', ar: 'سايبربنك', az: 'Cyberpunk'
            },
            'bubble': {
                tr: 'Kabarcık', en: 'Bubble', de: 'Blase', fr: 'Bulle', es: 'Burbuja', ru: 'Пузырь', zh: '气泡', ja: 'バブル', it: 'Bolla', pt: 'Bolha', ko: '버블', ar: 'فقاعة', az: 'Köpük'
            },
            
            'test_notifications': {
                tr: 'Test Bildirimleri', en: 'Test Notifications', de: 'Test-Benachrichtigungen', fr: 'Notifications de test', es: 'Notificaciones de prueba', ru: 'Тестовые уведомления', zh: '测试通知', ja: 'テスト通知', it: 'Notifiche di test', pt: 'Notificações de teste', ko: '테스트 알림', ar: 'إشعارات الاختبار', az: 'Test Bildirişləri'
            },
            'info_test': {
                tr: 'Bilgi', en: 'Info', de: 'Info', fr: 'Info', es: 'Info', ru: 'Инфо', zh: '信息', ja: '情報', it: 'Info', pt: 'Info', ko: '정보', ar: 'معلومات', az: 'Məlumat'
            },
            'success_test': {
                tr: 'Başarı', en: 'Success', de: 'Erfolg', fr: 'Succès', es: 'Éxito', ru: 'Успех', zh: '成功', ja: '成功', it: 'Successo', pt: 'Sucesso', ko: '성공', ar: 'نجاح', az: 'Uğur'
            },
            'warning_test': {
                tr: 'Uyarı', en: 'Warning', de: 'Warnung', fr: 'Avertissement', es: 'Advertencia', ru: 'Предупреждение', zh: '警告', ja: '警告', it: 'Avviso', pt: 'Aviso', ko: '경고', ar: 'تحذير', az: 'Xəbərdarlıq'
            },
            'error_test': {
                tr: 'Hata', en: 'Error', de: 'Fehler', fr: 'Erreur', es: 'Error', ru: 'Ошибка', zh: '错误', ja: 'エラー', it: 'Errore', pt: 'Erro', ko: '오류', ar: 'خطأ', az: 'Xəta'
            },
            
            'steam_page': {
                tr: 'Steam Sayfası', en: 'Steam Page', de: 'Steam-Seite', fr: 'Page Steam', es: 'Página de Steam', ru: 'Страница Steam', zh: 'Steam页面', ja: 'Steamページ', it: 'Pagina Steam', pt: 'Página Steam', ko: 'Steam 페이지', ar: 'صفحة Steam', az: 'Steam Səhifəsi'
            },
            'game_id': {
                tr: 'Oyun ID', en: 'Game ID', de: 'Spiel-ID', fr: 'ID du jeu', es: 'ID del juego', ru: 'ID игры', zh: '游戏ID', ja: 'ゲームID', it: 'ID gioco', pt: 'ID do jogo', ko: '게임 ID', ar: 'معرف اللعبة', az: 'Oyun ID'
            },
            'previous_page': {
                tr: 'Önceki Sayfa', en: 'Previous Page', de: 'Vorherige Seite', fr: 'Page précédente', es: 'Página anterior', ru: 'Предыдущая страница', zh: '上一页', ja: '前のページ', it: 'Pagina precedente', pt: 'Página anterior', ko: '이전 페이지', ar: 'الصفحة السابقة', az: 'Əvvəlki Səhifə'
            },
            'next_page': {
                tr: 'Sonraki Sayfa', en: 'Next Page', de: 'Nächste Seite', fr: 'Page suivante', es: 'Página siguiente', ru: 'Следующая страница', zh: '下一页', ja: '次のページ', it: 'Pagina successiva', pt: 'Próxima página', ko: '다음 페이지', ar: 'الصفحة التالية', az: 'Növbəti Səhifə'
            },
            'page_info': {
                tr: 'Sayfa {current} / {total} ({count} oyun)', en: 'Page {current} / {total} ({count} games)', de: 'Seite {current} / {total} ({count} Spiele)', fr: 'Page {current} / {total} ({count} jeux)', es: 'Página {current} / {total} ({count} juegos)', ru: 'Страница {current} / {total} ({count} игр)', zh: '第{current}页，共{total}页（{count}个游戏）', ja: 'ページ {current} / {total} ({count}ゲーム)', it: 'Pagina {current} / {total} ({count} giochi)', pt: 'Página {current} / {total} ({count} jogos)', ko: '페이지 {current} / {total} ({count}개 게임)', ar: 'الصفحة {current} / {total} ({count} لعبة)', az: 'Səhifə {current} / {total} ({count} oyun)'
            },
            
            'upload_game_file': {
                tr: 'Oyun Dosyasını Yükle', en: 'Upload Game File', de: 'Spieldatei hochladen', fr: 'Télécharger le fichier de jeu', es: 'Subir archivo del juego', ru: 'Загрузить файл игры', zh: '上传游戏文件', ja: 'ゲームファイルをアップロード', it: 'Carica file di gioco', pt: 'Enviar arquivo do jogo', ko: '게임 파일 업로드', ar: 'رفع ملف اللعبة', az: 'Oyun Faylını Yüklə'
            },
            'drag_drop_zip': {
                tr: 'ZIP dosyasını buraya sürükleyip bırakın veya tıklayarak seçin', en: 'Drag and drop ZIP file here or click to select', de: 'ZIP-Datei hierher ziehen oder klicken zum Auswählen', fr: 'Glissez-déposez le fichier ZIP ici ou cliquez pour sélectionner', es: 'Arrastra y suelta el archivo ZIP aquí o haz clic para seleccionar', ru: 'Перетащите ZIP файл сюда или нажмите для выбора', zh: '将ZIP文件拖放到此处或点击选择', ja: 'ZIPファイルをここにドラッグ＆ドロップするか、クリックして選択', it: 'Trascina e rilascia il file ZIP qui o clicca per selezionare', pt: 'Arraste e solte o arquivo ZIP aqui ou clique para selecionar', ko: 'ZIP 파일을 여기에 끌어다 놓거나 클릭하여 선택', ar: 'اسحب وأفلت ملف ZIP هنا أو انقر للاختيار', az: 'ZIP faylını buraya sürükləyin və ya seçmək üçün klikləyin'
            },
            'select_file': {
                tr: 'Dosya Seç', en: 'Select File', de: 'Datei auswählen', fr: 'Sélectionner le fichier', es: 'Seleccionar archivo', ru: 'Выбрать файл', zh: '选择文件', ja: 'ファイルを選択', it: 'Seleziona file', pt: 'Selecionar arquivo', ko: '파일 선택', ar: 'اختر الملف', az: 'Fayl Seç'
            },
            'game_info': {
                tr: 'Oyun Bilgileri', en: 'Game Information', de: 'Spielinformationen', fr: 'Informations sur le jeu', es: 'Información del juego', ru: 'Информация об игре', zh: '游戏信息', ja: 'ゲーム情報', it: 'Informazioni sul gioco', pt: 'Informações do jogo', ko: '게임 정보', ar: 'معلومات اللعبة', az: 'Oyun Məlumatları'
            },
            'game_name': {
                tr: 'Oyun Adı:', en: 'Game Name:', de: 'Spielname:', fr: 'Nom du jeu :', es: 'Nombre del juego:', ru: 'Название игры:', zh: '游戏名称:', ja: 'ゲーム名:', it: 'Nome del gioco:', pt: 'Nome do jogo:', ko: '게임 이름:', ar: 'اسم اللعبة:', az: 'Oyun Adı:'
            },
            'steam_app_id': {
                tr: 'Steam App ID:', en: 'Steam App ID:', de: 'Steam App-ID:', fr: 'ID de l\'app Steam :', es: 'ID de la app de Steam:', ru: 'Steam App ID:', zh: 'Steam应用ID:', ja: 'SteamアプリID:', it: 'ID app Steam:', pt: 'ID do app Steam:', ko: 'Steam 앱 ID:', ar: 'معرف تطبيق Steam:', az: 'Steam App ID:'
            },
            'install_game': {
                tr: 'Oyunu Kur', en: 'Install Game', de: 'Spiel installieren', fr: 'Installer le jeu', es: 'Instalar juego', ru: 'Установить игру', zh: '安装游戏', ja: 'ゲームをインストール', it: 'Installa gioco', pt: 'Instalar jogo', ko: '게임 설치', ar: 'تثبيت اللعبة', az: 'Oyunu Qura'
            },
            
            'discord_invite_title': {
                tr: 'Discord Sunucumuza Katıldınız mı?', en: 'Have you joined our Discord server?', de: 'Sind Sie unserem Discord-Server beigetreten?', fr: 'Avez-vous rejoint notre serveur Discord ?', es: '¿Te has unido a nuestro servidor de Discord?', ru: 'Вы присоединились к нашему Discord серверу?', zh: '您加入我们的Discord服务器了吗？', ja: 'Discordサーバーに参加しましたか？', it: 'Ti sei unito al nostro server Discord?', pt: 'Você se juntou ao nosso servidor Discord?', ko: 'Discord 서버에 참여하셨나요?', ar: 'هل انضممت إلى خادم Discord الخاص بنا؟', az: 'Discord serverimizə qoşuldunuzmu?'
            },
            'discord_invite_message': {
                tr: 'Güncellemeler, destek ve topluluk için Discord sunucumuza katılın.', en: 'Join our Discord server for updates, support and community.', de: 'Treten Sie unserem Discord-Server für Updates, Support und Community bei.', fr: 'Rejoignez notre serveur Discord pour les mises à jour, le support et la communauté.', es: 'Únete a nuestro servidor de Discord para actualizaciones, soporte y comunidad.', ru: 'Присоединяйтесь к нашему Discord серверу для обновлений, поддержки и сообщества.', zh: '加入我们的Discord服务器，获取更新、支持和社区。', ja: '更新、サポート、コミュニティのためにDiscordサーバーに参加してください。', it: 'Unisciti al nostro server Discord per aggiornamenti, supporto e comunità.', pt: 'Junte-se ao nosso servidor Discord para atualizações, suporte e comunidade.', ko: '업데이트, 지원 및 커뮤니티를 위해 Discord 서버에 참여하세요.', ar: 'انضم إلى خادم Discord الخاص بنا للحصول على التحديثات والدعم والمجتمع.', az: 'Yeniləmələr, dəstək və icma üçün Discord serverimizə qoşulun.'
            },
            'discord_later': {
                tr: 'Daha sonra', en: 'Later', de: 'Später', fr: 'Plus tard', es: 'Más tarde', ru: 'Позже', zh: '稍后', ja: '後で', it: 'Più tardi', pt: 'Mais tarde', ko: '나중에', ar: 'لاحقاً', az: 'Daha sonra'
            },
            'discord_join_server': {
                tr: 'Sunucuya Katıl', en: 'Join Server', de: 'Server beitreten', fr: 'Rejoindre le serveur', es: 'Unirse al servidor', ru: 'Присоединиться к серверу', zh: '加入服务器', ja: 'サーバーに参加', it: 'Unisciti al server', pt: 'Entrar no servidor', ko: '서버 참여', ar: 'انضم إلى الخادم', az: 'Serverə Qoşul'
            },
            'update_found_title': {
                tr: 'Yeni güncelleme bulundu', en: 'New update found', de: 'Neues Update gefunden', fr: 'Nouvelle mise à jour trouvée', es: 'Nueva actualización encontrada', ru: 'Найдено новое обновление', zh: '发现新更新', ja: '新しいアップデートが見つかりました', it: 'Nuovo aggiornamento trovato', pt: 'Nova atualização encontrada', ko: '새 업데이트 발견', ar: 'تم العثور على تحديث جديد', az: 'Yeni yeniləmə tapıldı'
            },
            'update_latest_version': {
                tr: 'En son sürüm', en: 'Latest version', de: 'Neueste Version', fr: 'Dernière version', es: 'Última versión', ru: 'Последняя версия', zh: '最新版本', ja: '最新バージョン', it: 'Ultima versione', pt: 'Versão mais recente', ko: '최신 버전', ar: 'أحدث إصدار', az: 'Ən son versiya'
            },
            'update_current_version': {
                tr: 'Mevcut sürüm', en: 'Current version', de: 'Aktuelle Version', fr: 'Version actuelle', es: 'Versión actual', ru: 'Текущая версия', zh: '当前版本', ja: '現在のバージョン', it: 'Versione attuale', pt: 'Versão atual', ko: '현재 버전', ar: 'الإصدار الحالي', az: 'Mövcud versiya'
            },
            'update_open_release': {
                tr: 'Güncellemeyi Aç', en: 'Open Release', de: 'Release öffnen', fr: 'Ouvrir la version', es: 'Abrir versión', ru: 'Открыть релиз', zh: '打开发布', ja: 'リリースを開く', it: 'Apri rilascio', pt: 'Abrir versão', ko: '릴리스 열기', ar: 'افتح الإصدار', az: 'Yeniləməni Aç'
            },
            
            'checking_online_fixes': {
                tr: 'Online düzeltmeler kontrol ediliyor...', en: 'Checking online fixes...', de: 'Online-Reparaturen werden überprüft...', fr: 'Vérification des corrections en ligne...', es: 'Verificando correcciones en línea...', ru: 'Проверка онлайн-исправлений...', zh: '检查在线修复...', ja: 'オンライン修正を確認中...', it: 'Controllo delle correzioni online...', pt: 'Verificando correções online...', ko: '온라인 수정 확인 중...', ar: 'جاري فحص التصحيحات عبر الإنترنت...', az: 'Online düzəlişlər yoxlanılır...'
            },
            'no_online_fixes_found': {
                tr: 'Online düzeltme bulunamadı', en: 'No online fixes found', de: 'Keine Online-Reparaturen gefunden', fr: 'Aucune correction en ligne trouvée', es: 'No se encontraron correcciones en línea', ru: 'Онлайн-исправления не найдены', zh: '未找到在线修复', ja: 'オンライン修正が見つかりません', it: 'Nessuna correzione online trovata', pt: 'Nenhuma correção online encontrada', ko: '온라인 수정을 찾을 수 없음', ar: 'لم يتم العثور على تصحيحات عبر الإنترنت', az: 'Online düzəliş tapılmadı'
            },
            'games_being_checked': {
                tr: 'oyun kontrol ediliyor...', en: 'games being checked...', de: 'Spiele werden überprüft...', fr: 'jeux en cours de vérification...', es: 'juegos siendo verificados...', ru: 'игр проверяется...', zh: '游戏正在检查中...', ja: 'ゲームをチェック中...', it: 'giochi in fase di controllo...', pt: 'jogos sendo verificados...', ko: '게임 확인 중...', ar: 'ألعاب قيد الفحص...', az: 'oyunlar yoxlanılır...'
            },
            'scanning_online_fix_database': {
                tr: 'Online fix veritabanı taranıyor...', en: 'Scanning online fix database...', de: 'Online-Reparatur-Datenbank wird gescannt...', fr: 'Scan de la base de données des corrections en ligne...', es: 'Escaneando base de datos de correcciones en línea...', ru: 'Сканирование базы данных онлайн-исправлений...', zh: '扫描在线修复数据库...', ja: 'オンライン修正データベースをスキャン中...', it: 'Scansione del database delle correzioni online...', pt: 'Escaneando banco de dados de correções online...', ko: '온라인 수정 데이터베이스 스캔 중...', ar: 'جاري فحص قاعدة بيانات التصحيحات عبر الإنترنت...', az: 'Online düzəliş verilənlər bazası taranır...'
            },
            'games_scanned': {
                tr: 'oyun tarandı', en: 'games scanned', de: 'Spiele gescannt', fr: 'jeux scannés', es: 'juegos escaneados', ru: 'игр просканировано', zh: '游戏已扫描', ja: 'ゲームスキャン完了', it: 'giochi scansionati', pt: 'jogos escaneados', ko: '게임 스캔됨', ar: 'ألعاب تم فحصها', az: 'oyunlar taranıb'
            },
            'no_online_fixes_info': {
                tr: 'Steam kütüphanenizde online fix bulunan oyun bulunamadı. Bu normal bir durum olabilir - sadece popüler oyunlar için online fix mevcuttur.', en: 'No games with online fixes found in your Steam library. This is normal - online fixes are only available for popular games.', de: 'In Ihrer Steam-Bibliothek wurden keine Spiele mit Online-Reparaturen gefunden. Das ist normal - Online-Reparaturen sind nur für beliebte Spiele verfügbar.', fr: 'Aucun jeu avec des corrections en ligne trouvé dans votre bibliothèque Steam. C\'est normal - les corrections en ligne ne sont disponibles que pour les jeux populaires.', es: 'No se encontraron juegos con correcciones en línea en tu biblioteca de Steam. Esto es normal - las correcciones en línea solo están disponibles para juegos populares.', ru: 'В вашей библиотеке Steam не найдено игр с онлайн-исправлениями. Это нормально - онлайн-исправления доступны только для популярных игр.', zh: '在您的Steam库中未找到具有在线修复的游戏。这是正常的 - 在线修复仅适用于热门游戏。', ja: 'Steamライブラリにオンライン修正のあるゲームが見つかりませんでした。これは正常です - オンライン修正は人気ゲームにのみ利用可能です。', it: 'Nessun gioco con correzioni online trovato nella tua libreria Steam. Questo è normale - le correzioni online sono disponibili solo per i giochi popolari.', pt: 'Nenhum jogo com correções online encontrado na sua biblioteca Steam. Isso é normal - as correções online só estão disponíveis para jogos populares.', ko: 'Steam 라이브러리에서 온라인 수정이 있는 게임을 찾을 수 없습니다. 이것은 정상입니다 - 온라인 수정은 인기 게임에만 사용할 수 있습니다.', ar: 'لم يتم العثور على ألعاب بها تصحيحات عبر الإنترنت في مكتبة Steam الخاصة بك. هذا طبيعي - التصحيحات عبر الإنترنت متاحة فقط للألعاب الشائعة.', az: 'Steam kitabxananızda online düzəliş olan oyun tapılmadı. Bu normaldir - online düzəlişlər yalnız populyar oyunlar üçün mövcuddur.'
            },
            'online_fix_role_required': {
                tr: 'Online Fix Rolünüz Yok', en: 'Online Fix Role Required', de: 'Online-Fix-Rolle erforderlich', fr: 'Rôle de correction en ligne requis', es: 'Rol de corrección en línea requerido', ru: 'Требуется роль онлайн-исправления', zh: '需要在线修复角色', ja: 'オンライン修正ロールが必要', it: 'Ruolo di correzione online richiesto', pt: 'Função de correção online necessária', ko: '온라인 수정 역할 필요', ar: 'مطلوب دور التصحيح عبر الإنترنت', az: 'Online Düzəliş Rolu Tələb Olunur'
            },
            'online_fix_role_description': {
                tr: 'Online fix rolünüz yok. Lütfen Discord\'dan rolü almak için görevleri yapın.', en: 'You don\'t have the online fix role. Please complete tasks on Discord to get the role.', de: 'Sie haben nicht die Online-Fix-Rolle. Bitte erledigen Sie Aufgaben auf Discord, um die Rolle zu erhalten.', fr: 'Vous n\'avez pas le rôle de correction en ligne. Veuillez accomplir des tâches sur Discord pour obtenir le rôle.', es: 'No tienes el rol de corrección en línea. Por favor, completa tareas en Discord para obtener el rol.', ru: 'У вас нет роли онлайн-исправления. Пожалуйста, выполните задания в Discord, чтобы получить роль.', zh: '您没有在线修复角色。请在Discord上完成任务以获得角色。', ja: 'オンライン修正ロールがありません。Discordでタスクを完了してロールを取得してください。', it: 'Non hai il ruolo di correzione online. Per favore, completa le attività su Discord per ottenere il ruolo.', pt: 'Você não tem a função de correção online. Por favor, complete tarefas no Discord para obter a função.', ko: '온라인 수정 역할이 없습니다. Discord에서 작업을 완료하여 역할을 얻으세요.', ar: 'ليس لديك دور التصحيح عبر الإنترنت. يرجى إكمال المهام على Discord للحصول على الدور.', az: 'Online düzəliş rolunuz yoxdur. Zəhmət olmasa Discord\'da tapşırıqları yerinə yetirin ki, rolu əldə edəsiniz.'
            },
            'online_fix_role_instructions': {
                tr: 'Rolü aldıktan sonra uygulama üzerindeki hesabınızdan çıkıp girmeniz lazım tanımlanması için.', en: 'After getting the role, you need to log out and log back in to your account in the application for it to be recognized.', de: 'Nach dem Erhalt der Rolle müssen Sie sich in der Anwendung abmelden und wieder anmelden, damit sie erkannt wird.', fr: 'Après avoir obtenu le rôle, vous devez vous déconnecter et vous reconnecter à votre compte dans l\'application pour qu\'il soit reconnu.', es: 'Después de obtener el rol, necesitas cerrar sesión y volver a iniciar sesión en tu cuenta en la aplicación para que sea reconocido.', ru: 'После получения роли вам нужно выйти и снова войти в свой аккаунт в приложении, чтобы она была распознана.', zh: '获得角色后，您需要在应用程序中注销并重新登录您的账户以使其被识别。', ja: 'ロールを取得した後、認識されるようにアプリケーションでアカウントからログアウトしてログインし直す必要があります。', it: 'Dopo aver ottenuto il ruolo, devi disconnetterti e riconnetterti al tuo account nell\'applicazione perché venga riconosciuto.', pt: 'Após obter a função, você precisa fazer logout e login novamente em sua conta no aplicativo para que seja reconhecida.', ko: '역할을 얻은 후 인식되도록 애플리케이션에서 계정에서 로그아웃하고 다시 로그인해야 합니다.', ar: 'بعد الحصول على الدور، تحتاج إلى تسجيل الخروج وتسجيل الدخول مرة أخرى إلى حسابك في التطبيق ليتم التعرف عليه.', az: 'Rolu aldıqdan sonra tətbiqdə hesabınızdan çıxıb yenidən girməlisiniz ki, tanınsın.'
            },
            'join_discord': {
                tr: 'Discord\'a Katıl', en: 'Join Discord', de: 'Discord beitreten', fr: 'Rejoindre Discord', es: 'Unirse a Discord', ru: 'Присоединиться к Discord', zh: '加入Discord', ja: 'Discordに参加', it: 'Unisciti a Discord', pt: 'Entrar no Discord', ko: 'Discord 참여', ar: 'انضم إلى Discord', az: 'Discord\'a Qoşul'
            },

            'bypass': {
                tr: 'Bypass', en: 'Bypass', de: 'Bypass', fr: 'Bypass', es: 'Bypass', ru: 'Обход', zh: '绕过', ja: 'バイパス', it: 'Bypass', pt: 'Bypass', ko: '우회', pl: 'Bypass', az: 'Bypass'
            },
            'loading_bypass_games': {
                tr: 'Bypass oyunları yükleniyor...', en: 'Loading bypass games...', de: 'Bypass-Spiele werden geladen...', fr: 'Chargement des jeux bypass...', es: 'Cargando juegos bypass...', ru: 'Загрузка игр обхода...', zh: '正在加载绕过游戏...', ja: 'バイパスゲームを読み込んでいます...', it: 'Caricamento giochi bypass...', pt: 'Carregando jogos bypass...', ko: '우회 게임 로딩 중...', pl: 'Ładowanie gier bypass...', az: 'Bypass oyunları yüklənir...'
            },
            'fetching_bypass_database': {
                tr: 'Bypass veritabanı taranıyor...', en: 'Scanning bypass database...', de: 'Bypass-Datenbank wird gescannt...', fr: 'Scan de la base de données bypass...', es: 'Escaneando base de datos bypass...', ru: 'Сканирование базы данных обхода...', zh: '正在扫描绕过数据库...', ja: 'バイパスデータベースをスキャンしています...', it: 'Scansione database bypass...', pt: 'Escaneando banco de dados bypass...', ko: '우회 데이터베이스 스캔 중...', pl: 'Skanowanie bazy danych bypass...', az: 'Bypass veritabanı taranır...'
            },
            'no_bypass_found': {
                tr: 'Bypass bulunamadı', en: 'No bypass found', de: 'Kein Bypass gefunden', fr: 'Aucun bypass trouvé', es: 'No se encontró bypass', ru: 'Обход не найден', zh: '未找到绕过', ja: 'バイパスが見つかりません', it: 'Nessun bypass trovato', pt: 'Nenhum bypass encontrado', ko: '우회를 찾을 수 없습니다', pl: 'Nie znaleziono bypass', az: 'Bypass tapılmadı'
            },
            'no_bypass_info': {
                tr: 'Bypass veritabanında oyun bulunamadı. Bu durum geçici olabilir - veritabanı sürekli güncellenmektedir.', en: 'No games found in bypass database. This may be temporary - the database is constantly updated.', de: 'Keine Spiele in der Bypass-Datenbank gefunden. Dies kann vorübergehend sein - die Datenbank wird ständig aktualisiert.', fr: 'Aucun jeu trouvé dans la base de données bypass. Cela peut être temporaire - la base de données est constamment mise à jour.', es: 'No se encontraron juegos en la base de datos bypass. Esto puede ser temporal - la base de datos se actualiza constantemente.', ru: 'В базе данных обхода не найдено игр. Это может быть временно - база данных постоянно обновляется.', zh: '在绕过数据库中未找到游戏。这可能是暂时的 - 数据库正在不断更新。', ja: 'バイパスデータベースにゲームが見つかりませんでした。これは一時的かもしれません - データベースは常に更新されています。', it: 'Nessun gioco trovato nel database bypass. Questo potrebbe essere temporaneo - il database viene costantemente aggiornato.', pt: 'Nenhum jogo encontrado no banco de dados bypass. Isso pode ser temporário - o banco de dados é constantemente atualizado.', ko: '우회 데이터베이스에서 게임을 찾을 수 없습니다. 이는 일시적일 수 있습니다 - 데이터베이스는 지속적으로 업데이트됩니다.', pl: 'Nie znaleziono gier w bazie danych bypass. To może być tymczasowe - baza danych jest stale aktualizowana.', az: 'Bypass veritabanında oyun tapılmadı. Bu müvəqqəti ola bilər - veritabanı davamlı yenilənir.'
            },
            'download_bypass': {
                tr: 'Bypass İndir', en: 'Download Bypass', de: 'Bypass herunterladen', fr: 'Télécharger Bypass', es: 'Descargar Bypass', ru: 'Скачать обход', zh: '下载绕过', ja: 'バイパスをダウンロード', it: 'Scarica Bypass', pt: 'Baixar Bypass', ko: '우회 다운로드', pl: 'Pobierz Bypass', az: 'Bypass yüklə'
            },
            'remove_bypass': {
                tr: 'Bypass Kaldır', en: 'Remove Bypass', de: 'Bypass entfernen', fr: 'Supprimer Bypass', es: 'Eliminar Bypass', ru: 'Удалить обход', zh: '删除绕过', ja: 'バイパスを削除', it: 'Rimuovi Bypass', pt: 'Remover Bypass', ko: '우회 제거', pl: 'Usuń Bypass', az: 'Bypass sil'
            },
            'downloading_bypass': {
                tr: 'Bypass indiriliyor...', en: 'Downloading bypass...', de: 'Bypass wird heruntergeladen...', fr: 'Téléchargement du bypass...', es: 'Descargando bypass...', ru: 'Загрузка обхода...', zh: '正在下载绕过...', ja: 'バイパスをダウンロードしています...', it: 'Download bypass in corso...', pt: 'Baixando bypass...', ko: '우회 다운로드 중...', pl: 'Pobieranie bypass...', az: 'Bypass yüklənir...'
            },
            'installing_game': {
                tr: 'Oyun kuruluyor...', en: 'Installing game...', de: 'Spiel wird installiert...', fr: 'Installation du jeu...', es: 'Instalando juego...', ru: 'Установка игры...', zh: '正在安装游戏...', ja: 'ゲームをインストール中...', it: 'Installazione gioco...', pt: 'Instalando jogo...', ko: '게임 설치 중...', pl: 'Instalowanie gry...', az: 'Oyun quraşdırılır...'
            },
            'downloading_bypass_archive': {
                tr: 'Bypass arşivi indiriliyor...', en: 'Downloading bypass archive...', de: 'Bypass-Archiv wird heruntergeladen...', fr: 'Téléchargement de l\'archive bypass...', es: 'Descargando archivo bypass...', ru: 'Загрузка архива обхода...', zh: '正在下载绕过存档...', ja: 'バイパスアーカイブをダウンロード中...', it: 'Download archivio bypass...', pt: 'Baixando arquivo bypass...', ko: '우회 아카이브 다운로드 중...', pl: 'Pobieranie archiwum bypass...', az: 'Bypass arxivi yüklənir...'
            },
            'installing_bypass_archive': {
                tr: 'Bypass arşivi kuruluyor...', en: 'Installing bypass archive...', de: 'Bypass-Archiv wird installiert...', fr: 'Installation de l\'archive bypass...', es: 'Instalando archivo bypass...', ru: 'Установка архива обхода...', zh: '正在安装绕过存档...', ja: 'バイパスアーカイブをインストール中...', it: 'Installazione archivio bypass...', pt: 'Instalando arquivo bypass...', ko: '우회 아카이브 설치 중...', pl: 'Instalowanie archiwum bypass...', az: 'Bypass arxivi quraşdırılır...'
            },
            'refreshing_library': {
                tr: 'Kütüphane yenileniyor...', en: 'Refreshing library...', de: 'Bibliothek wird aktualisiert...', fr: 'Actualisation de la bibliothèque...', es: 'Actualizando biblioteca...', ru: 'Обновление библиотеки...', zh: '正在刷新库...', ja: 'ライブラリを更新中...', it: 'Aggiornamento biblioteca...', pt: 'Atualizando biblioteca...', ko: '라이브러리 새로고침 중...', pl: 'Odświeżanie biblioteki...', az: 'Kitabxana yenilənir...'
            },
            'library_refreshed': {
                tr: 'Kütüphane başarıyla yenilendi', en: 'Library refreshed successfully', de: 'Bibliothek erfolgreich aktualisiert', fr: 'Bibliothèque actualisée avec succès', es: 'Biblioteca actualizada exitosamente', ru: 'Библиотека успешно обновлена', zh: '库刷新成功', ja: 'ライブラリが正常に更新されました', it: 'Biblioteca aggiornata con successo', pt: 'Biblioteca atualizada com sucesso', ko: '라이브러리가 성공적으로 새로고침되었습니다', pl: 'Biblioteka została pomyślnie odświeżona', az: 'Kitabxana uğurla yeniləndi'
            },
            'library_refresh_failed': {
                tr: 'Kütüphane yenilenemedi', en: 'Failed to refresh library', de: 'Bibliothek konnte nicht aktualisiert werden', fr: 'Échec de l\'actualisation de la bibliothèque', es: 'Error al actualizar biblioteca', ru: 'Не удалось обновить библиотеку', zh: '刷新库失败', ja: 'ライブラリの更新に失敗しました', it: 'Impossibile aggiornare la biblioteca', pt: 'Falha ao atualizar biblioteca', ko: '라이브러리 새로고침 실패', pl: 'Nie udało się odświeżyć biblioteki', az: 'Kitabxana yenilənə bilmədi'
            },
            'library_load_failed': {
                tr: 'Kütüphane yüklenemedi', en: 'Failed to load library', de: 'Bibliothek konnte nicht geladen werden', fr: 'Échec du chargement de la bibliothèque', es: 'Error al cargar biblioteca', ru: 'Не удалось загрузить библиотеку', zh: '加载库失败', ja: 'ライブラリの読み込みに失敗しました', it: 'Impossibile caricare la biblioteca', pt: 'Falha ao carregar biblioteca', ko: '라이브러리 로드 실패', pl: 'Nie udało się załadować biblioteki', az: 'Kitabxana yüklənə bilmədi'
            },
            'games_load_failed': {
                tr: 'Oyunlar yüklenemedi', en: 'Failed to load games', de: 'Spiele konnten nicht geladen werden', fr: 'Échec du chargement des jeux', es: 'Error al cargar juegos', ru: 'Не удалось загрузить игры', zh: '加载游戏失败', ja: 'ゲームの読み込みに失敗しました', it: 'Impossibile caricare i giochi', pt: 'Falha ao carregar jogos', ko: '게임 로드 실패', pl: 'Nie udało się załadować gier', az: 'Oyunlar yüklənə bilmədi'
            },
            'steam_restarting': {
                tr: 'Steam yeniden başlatılıyor', en: 'Steam is restarting', de: 'Steam wird neu gestartet', fr: 'Steam redémarre', es: 'Steam se está reiniciando', ru: 'Steam перезапускается', zh: 'Steam正在重启', ja: 'Steamを再起動しています', it: 'Steam si sta riavviando', pt: 'Steam está reiniciando', ko: 'Steam 재시작 중', pl: 'Steam się restartuje', az: 'Steam yenidən başladılır'
            },
            'steam_restart_failed': {
                tr: 'Steam yeniden başlatılamadı', en: 'Failed to restart Steam', de: 'Steam konnte nicht neu gestartet werden', fr: 'Échec du redémarrage de Steam', es: 'Error al reiniciar Steam', ru: 'Не удалось перезапустить Steam', zh: 'Steam重启失败', ja: 'Steamの再起動に失敗しました', it: 'Impossibile riavviare Steam', pt: 'Falha ao reiniciar Steam', ko: 'Steam 재시작 실패', pl: 'Nie udało się zrestartować Steam', az: 'Steam yenidən başladıla bilmədi'
            },
            'testing_loading_screen': {
                tr: 'Test yükleme ekranı...', en: 'Testing loading screen...', de: 'Ladebildschirm wird getestet...', fr: 'Test de l\'écran de chargement...', es: 'Probando pantalla de carga...', ru: 'Тестирование экрана загрузки...', zh: '测试加载屏幕...', ja: 'ローディング画面をテスト中...', it: 'Test schermata di caricamento...', pt: 'Testando tela de carregamento...', ko: '로딩 화면 테스트 중...', pl: 'Testowanie ekranu ładowania...', az: 'Yükləmə ekranı test edilir...'
            },
            'removing_bypass': {
                tr: 'Bypass kaldırılıyor...', en: 'Removing bypass...', de: 'Bypass wird entfernt...', fr: 'Suppression du bypass...', es: 'Eliminando bypass...', ru: 'Удаление обхода...', zh: '正在删除绕过...', ja: 'バイパスを削除しています...', it: 'Rimozione bypass...', pt: 'Removendo bypass...', ko: '우회 제거 중...', pl: 'Usuwanie bypass...', az: 'Bypass silinir...'
            },
            'bypass_installed': {
                tr: 'Bypass başarıyla kuruldu', en: 'Bypass installed successfully', de: 'Bypass erfolgreich installiert', fr: 'Bypass installé avec succès', es: 'Bypass instalado exitosamente', ru: 'Обход успешно установлен', zh: '绕过安装成功', ja: 'バイパスが正常にインストールされました', it: 'Bypass installato con successo', pt: 'Bypass instalado com sucesso', ko: '우회가 성공적으로 설치되었습니다', pl: 'Bypass zainstalowany pomyślnie', az: 'Bypass uğurla quraşdırıldı'
            },
            'bypass_removed': {
                tr: 'Bypass başarıyla kaldırıldı', en: 'Bypass removed successfully', de: 'Bypass erfolgreich entfernt', fr: 'Bypass supprimé avec succès', es: 'Bypass eliminado exitosamente', ru: 'Обход успешно удален', zh: '绕过删除成功', ja: 'バイパスが正常に削除されました', it: 'Bypass rimosso con successo', pt: 'Bypass removido com sucesso', ko: '우회가 성공적으로 제거되었습니다', pl: 'Bypass usunięty pomyślnie', az: 'Bypass uğurla silindi'
            },
            'error_occurred': {
                tr: 'Hata Oluştu', en: 'Error Occurred', de: 'Fehler aufgetreten', fr: 'Erreur survenue', es: 'Error ocurrido', ru: 'Произошла ошибка', zh: '发生错误', ja: 'エラーが発生しました', it: 'Errore verificato', pt: 'Erro ocorrido', ko: '오류 발생', pl: 'Wystąpił błąd', az: 'Xəta baş verdi'
            },
            
            'game_not_found': {
                tr: 'Oyun bulunamadı', en: 'Game not found', de: 'Spiel nicht gefunden', fr: 'Jeu introuvable', es: 'Juego no encontrado', ru: 'Игра не найдена', zh: '游戏未找到', ja: 'ゲームが見つかりません', it: 'Gioco non trovato', pt: 'Jogo não encontrado', ko: '게임을 찾을 수 없음', ar: 'اللعبة غير موجودة', az: 'Oyun tapılmadı'
            },
            'api_connection_error': {
                tr: 'API bağlantı hatası', en: 'API connection error', de: 'API-Verbindungsfehler', fr: 'Erreur de connexion API', es: 'Error de conexión API', ru: 'Ошибка подключения к API', zh: 'API连接错误', ja: 'API接続エラー', it: 'Errore di connessione API', pt: 'Erro de conexão API', ko: 'API 연결 오류', ar: 'خطأ في الاتصال بـ API', az: 'API bağlantı xətası'
            },
            'fill_all_fields': {
                tr: 'Lütfen tüm alanları doldurun', en: 'Please fill in all fields', de: 'Bitte füllen Sie alle Felder aus', fr: 'Veuillez remplir tous les champs', es: 'Por favor complete todos los campos', ru: 'Пожалуйста, заполните все поля', zh: '请填写所有字段', ja: 'すべてのフィールドを入力してください', it: 'Si prega di compilare tutti i campi', pt: 'Por favor, preencha todos os campos', ko: '모든 필드를 입력해주세요', ar: 'يرجى ملء جميع الحقول', az: 'Zəhmət olmasa bütün sahələri doldurun'
            },
            'login_failed': {
                tr: 'Giriş yapılamadı, lütfen tekrar deneyin', en: 'Login failed, please try again', de: 'Anmeldung fehlgeschlagen, bitte versuchen Sie es erneut', fr: 'La connexion a échoué, veuillez réessayer', es: 'El inicio de sesión falló, por favor inténtelo de nuevo', ru: 'Вход не удался, пожалуйста, попробуйте снова', zh: '登录失败，请重试', ja: 'ログインに失敗しました。もう一度お試しください', it: 'Accesso fallito, riprova', pt: 'Falha no login, tente novamente', ko: '로그인 실패, 다시 시도해주세요', ar: 'فشل تسجيل الدخول، يرجى المحاولة مرة أخرى', az: 'Giriş uğursuz oldu, zəhmət olmasa yenidən cəhd edin'
            },
            'jwt_token_not_found': {
                tr: 'JWT token bulunamadı', en: 'JWT token not found', de: 'JWT-Token nicht gefunden', fr: 'Jeton JWT introuvable', es: 'Token JWT no encontrado', ru: 'JWT токен не найден', zh: '未找到JWT令牌', ja: 'JWTトークンが見つかりません', it: 'Token JWT non trovato', pt: 'Token JWT não encontrado', ko: 'JWT 토큰을 찾을 수 없음', ar: 'لم يتم العثور على رمز JWT', az: 'JWT token tapılmadı'
            },
            'session_expired': {
                tr: 'Oturum süresi doldu, lütfen tekrar giriş yapın', en: 'Session expired, please login again', de: 'Sitzung abgelaufen, bitte melden Sie sich erneut an', fr: 'Session expirée, veuillez vous reconnecter', es: 'Sesión expirada, por favor inicie sesión nuevamente', ru: 'Сессия истекла, пожалуйста, войдите снова', zh: '会话已过期，请重新登录', ja: 'セッションが期限切れです。再度ログ인してください', it: 'Sessione scaduta, effettua nuovamente l\'accesso', pt: 'Sessão expirada, faça login novamente', ko: '세션이 만료되었습니다. 다시 로그인하세요', ar: 'انتهت صلاحية الجلسة، يرجى تسجيل الدخول مرة أخرى', az: 'Sessiya vaxtı bitdi, zəhmət olmasa yenidən giriş edin'
            },
            
            'zip_file_corrupted': {
                tr: 'ZIP dosyası bozuk veya eksik. Lütfen dosyayı yeniden indirin.', en: 'ZIP file is corrupted or incomplete. Please download the file again.', de: 'ZIP-Datei ist beschädigt oder unvollständig. Bitte laden Sie die Datei erneut herunter.', fr: 'Le fichier ZIP est corrompu ou incomplet. Veuillez télécharger le fichier à nouveau.', es: 'El archivo ZIP está corrupto o incompleto. Por favor, descargue el archivo nuevamente.', ru: 'ZIP файл поврежден или неполон. Пожалуйста, скачайте файл заново.', zh: 'ZIP文件已损坏或不完整。请重新下载文件。', ja: 'ZIPファイルが破損しているか不完全です。ファイルを再ダウンロードしてください。', it: 'Il file ZIP è corrotto o incompleto. Si prega di scaricare nuovamente il file.', pt: 'O arquivo ZIP está corrompido ou incompleto. Por favor, baixe o arquivo novamente.', ko: 'ZIP 파일이 손상되었거나 불완전합니다. 파일을 다시 다운로드하세요.', ar: 'ملف ZIP تالف أو غير مكتمل. يرجى إعادة تحميل الملف.', az: 'ZIP faylı korlanmış və ya natamdır. Zəhmət olmasa faylı yenidən yükləyin.'
            },
            'game_file_error': {
                tr: 'Oyun dosyası işlenirken hata oluştu. Lütfen dosyayı kontrol edin.', en: 'An error occurred while processing the game file. Please check the file.', de: 'Beim Verarbeiten der Spieldatei ist ein Fehler aufgetreten. Bitte überprüfen Sie die Datei.', fr: 'Une erreur s\'est produite lors du traitement du fichier de jeu. Veuillez vérifier le fichier.', es: 'Ocurrió un error al procesar el archivo del juego. Por favor, verifique el archivo.', ru: 'Произошла ошибка при обработке файла игры. Пожалуйста, проверьте файл.', zh: '处理游戏文件时发生错误。请检查文件。', ja: 'ゲームファイルの処理中にエラーが発生しました。ファイルを確認してください。', it: 'Si è verificato un errore durante l\'elaborazione del file di gioco. Si prega di controllare il file.', pt: 'Ocorreu um erro ao processar o arquivo do jogo. Por favor, verifique o arquivo.', ko: '게임 파일을 처리하는 중 오류가 발생했습니다. 파일을 확인해주세요.', ar: 'حدث خطأ أثناء معالجة ملف اللعبة. يرجى التحقق من الملف.', az: 'Oyun faylını emal edərkən xəta baş verdi. Zəhmət olmasa faylı yoxlayın.'
            },
            
            'game_added_success': {
                tr: 'Oyun başarıyla kütüphaneye eklendi', en: 'Game successfully added to library', de: 'Spiel erfolgreich zur Bibliothek hinzugefügt', fr: 'Jeu ajouté avec succès à la bibliothèque', es: 'Juego añadido exitosamente a la biblioteca', ru: 'Игра успешно добавлена в библиотеку', zh: '游戏已成功添加到库', ja: 'ゲームがライブラリに正常に追加されました', it: 'Gioco aggiunto con successo alla libreria', pt: 'Jogo adicionado com sucesso à biblioteca', ko: '게임이 라이브러리에 성공적으로 추가되었습니다', ar: 'تمت إضافة اللعبة إلى المكتبة بنجاح', az: 'Oyun kitabxanaya uğurla əlavə edildi'
            },
            'game_add_failed': {
                tr: 'Oyun kütüphaneye eklenemedi', en: 'Failed to add game to library', de: 'Spiel konnte nicht zur Bibliothek hinzugefügt werden', fr: 'Échec de l\'ajout du jeu à la bibliothèque', es: 'No se pudo añadir el juego a la biblioteca', ru: 'Не удалось добавить игру в библиотеку', zh: '无法将游戏添加到库', ja: 'ゲームをライブラリに追加できませんでした', it: 'Impossibile aggiungere il gioco alla libreria', pt: 'Falha ao adicionar jogo à biblioteca', ko: '게임을 라이브러리에 추가할 수 없습니다', ar: 'فشل في إضافة اللعبة إلى المكتبة', az: 'Oyun kitabxanaya əlavə edilə bilmədi'
            },
            'minimal': {
                tr: 'Minimal', en: 'Minimal', de: 'Minimal', fr: 'Minimal', es: 'Minimalista', ru: 'Минимальный', zh: '极简', ja: 'ミニマル', it: 'Minimale', pt: 'Minimal', ko: '미니멀', ar: 'أدنى', az: 'Minimal'
            },
            'retro': {
                tr: 'Retro', en: 'Retro', de: 'Retro', fr: 'Rétro', es: 'Retro', ru: 'Ретро', zh: '复古', ja: 'レトロ', it: 'Retro', pt: 'Retro', ko: '레트로', ar: 'كلاسيكي', az: 'Retro'
            },
            'cyberpunk': {
                tr: 'Cyberpunk', en: 'Cyberpunk', de: 'Cyberpunk', fr: 'Cyberpunk', es: 'Cyberpunk', ru: 'Киберпанк', zh: '赛博朋克', ja: 'サイバーパンク', it: 'Cyberpunk', pt: 'Cyberpunk', ko: '사이버펑크', ar: 'سايبربانك', az: 'Kiberpunk'
            },
            'bubble': {
                tr: 'Kabarcık', en: 'Bubble', de: 'Blase', fr: 'Bulle', es: 'Burbuja', ru: 'Пузырь', zh: '气泡', ja: 'バブル', it: 'Bolla', pt: 'Bolha', ko: '버블', ar: 'فقاعة', az: 'Qabarcıq'
            },
            'anime': {
                tr: 'Anime', en: 'Anime', de: 'Anime', fr: 'Anime', es: 'Anime', ru: 'Аниме', zh: '动漫', ja: 'アニメ', it: 'Anime', pt: 'Anime', ko: '애니메', ar: 'أنمي', az: 'Anime'
            },
            'steampunk': {
                tr: 'Steampunk', en: 'Steampunk', de: 'Steampunk', fr: 'Steampunk', es: 'Steampunk', ru: 'Стимпанк', zh: '蒸汽朋克', ja: 'スチームパンク', it: 'Steampunk', pt: 'Steampunk', ko: '스팀펑크', ar: 'ستيمبانك', az: 'Steampunk'
            },
            'hologram': {
                tr: 'Hologram', en: 'Hologram', de: 'Hologramm', fr: 'Hologramme', es: 'Holograma', ru: 'Голограмма', zh: '全息图', ja: 'ホログラム', it: 'Ologramma', pt: 'Holograma', ko: '홀로그램', ar: 'صورة ثلاثية', az: 'Holoqram'
            },
            'matrix': {
                tr: 'Matrix', en: 'Matrix', de: 'Matrix', fr: 'Matrice', es: 'Matriz', ru: 'Матрица', zh: '矩阵', ja: 'マトリックス', it: 'Matrice', pt: 'Matriz', ko: '매트릭스', ar: 'مصفوفة', az: 'Matris'
            },
            'gradient': {
                tr: 'Gradient', en: 'Gradient', de: 'Gradient', fr: 'Gradient', es: 'Gradiente', ru: 'Градиент', zh: '渐变', ja: 'グラデーション', it: 'Gradiente', pt: 'Gradiente', ko: '그라데이션', ar: 'تدرج', az: 'Qradient'
            },
            'test_notifications': {
                tr: 'Test Bildirimleri', en: 'Test Notifications', de: 'Test-Benachrichtigungen', fr: 'Notifications de test', es: 'Notificaciones de prueba', ru: 'Тестовые уведомления', zh: '测试通知', ja: 'テスト通知', it: 'Notifiche di test', pt: 'Notificações de teste', ko: '테스트 알림', ar: 'إشعارات الاختبار', az: 'Test Bildirişləri'
            },
            'notification_customization': {
                tr: 'Bildirim görünümünü ve sesini özelleştir', en: 'Customize notification appearance and sound', de: 'Benachrichtigungsdarstellung und -ton anpassen', fr: 'Personnaliser l\'apparence et le son des notifications', es: 'Personalizar apariencia y sonido de notificaciones', ru: 'Настройка внешнего вида и звука уведомлений', zh: '自定义通知外观和声音', ja: '通知の外観とサウンドをカスタマイズ', it: 'Personalizza aspetto e suono delle notifiche', pt: 'Personalizar aparência e som das notificações', ko: '알림 모양과 소리 사용자 정의', ar: 'تخصيص مظهر وصوت الإشعارات', az: 'Bildiriş görünüşünü və səsini fərdiləşdir'
            },
            'notification_styles': {
                tr: 'Bildirim Stilleri', en: 'Notification Styles', de: 'Benachrichtigungsstile', fr: 'Styles de notification', es: 'Estilos de notificación', ru: 'Стили уведомлений', zh: '通知样式', ja: '通知スタイル', it: 'Stili notifica', pt: 'Estilos de notificação', ko: '알림 스타일', ar: 'أنماط الإشعارات', az: 'Bildiriş Stilləri'
            },
            'sound_enabled': {
                tr: 'Ses Açık', en: 'Sound Enabled', de: 'Ton aktiviert', fr: 'Son activé', es: 'Sonido habilitado', ru: 'Звук включен', zh: '启用声音', ja: 'サウンド有効', it: 'Audio abilitato', pt: 'Som ativado', ko: '소리 활성화', ar: 'الصوت مفعل', az: 'Səs Aktiv'
            },
            'info_test': {
                tr: 'Bilgi', en: 'Info', de: 'Info', fr: 'Info', es: 'Información', ru: 'Информация', zh: '信息', ja: '情報', it: 'Info', pt: 'Informação', ko: '정보', ar: 'معلومات', az: 'Məlumat'
            },
            'success_test': {
                tr: 'Başarı', en: 'Success', de: 'Erfolg', fr: 'Succès', es: 'Éxito', ru: 'Успех', zh: '成功', ja: '成功', it: 'Successo', pt: 'Sucesso', ko: '성공', ar: 'نجاح', az: 'Uğur'
            },
            'warning_test': {
                tr: 'Uyarı', en: 'Warning', de: 'Warnung', fr: 'Avertissement', es: 'Advertencia', ru: 'Предупреждение', zh: '警告', ja: '警告', it: 'Avviso', pt: 'Aviso', ko: '경고', ar: 'تحذير', az: 'Xəbərdarlıq'
            },
            'error_test': {
                tr: 'Hata', en: 'Error', de: 'Fehler', fr: 'Erreur', es: 'Error', ru: 'Ошибка', zh: '错误', ja: 'エラー', it: 'Errore', pt: 'Erro', ko: '오류', ar: 'خطأ', az: 'Xəta'
            },
            'duration': {
                tr: 'Süre:', en: 'Duration:', de: 'Dauer:', fr: 'Durée:', es: 'Duración:', ru: 'Продолжительность:', zh: '持续时间:', ja: '期間:', it: 'Durata:', pt: 'Duração:', ko: '지속 시간:', ar: 'المدة:', az: 'Müddət:'
            },
            'animation': {
                tr: 'Animasyon:', en: 'Animation:', de: 'Animation:', fr: 'Animation:', es: 'Animación:', ru: 'Анимация:', zh: '动画:', ja: 'アニメーション:', it: 'Animazione:', pt: 'Animação:', ko: '애니메이션:', ar: 'الرسوم المتحركة:', az: 'Animasiya:'
            },
            'slide': {
                tr: 'Kaydırma', en: 'Slide', de: 'Gleiten', fr: 'Glissement', es: 'Deslizar', ru: 'Скольжение', zh: '滑动', ja: 'スライド', it: 'Scorrimento', pt: 'Deslizar', ko: '슬라이드', ar: 'انزلاق', az: 'Sürüşmə'
            },
            'bounce': {
                tr: 'Zıplama', en: 'Bounce', de: 'Hüpfen', fr: 'Rebond', es: 'Rebote', ru: 'Отскок', zh: '弹跳', ja: 'バウンス', it: 'Rimbalzo', pt: 'Quicar', ko: '바운스', ar: 'ارتداد', az: 'Sıçrama'
            },
            'scale': {
                tr: 'Ölçekleme', en: 'Scale', de: 'Skalierung', fr: 'Échelle', es: 'Escala', ru: 'Масштабирование', zh: '缩放', ja: 'スケール', it: 'Scala', pt: 'Escala', ko: '스케일', ar: 'قياس', az: 'Ölçüləmə'
            },
            'sound_volume': {
                tr: 'Ses Seviyesi:', en: 'Sound Volume:', de: 'Lautstärke:', fr: 'Volume sonore:', es: 'Volumen de sonido:', ru: 'Громкость звука:', zh: '音量:', ja: '音量:', it: 'Volume audio:', pt: 'Volume do som:', ko: '음량:', ar: 'مستوى الصوت:', az: 'Səs Səviyyəsi:'
            },
            'sound_file': {
                tr: 'Ses Dosyası:', en: 'Sound File:', de: 'Audiodatei:', fr: 'Fichier audio:', es: 'Archivo de sonido:', ru: 'Звуковой файл:', zh: '音频文件:', ja: '音声ファイル:', it: 'File audio:', pt: 'Arquivo de som:', ko: '오디오 파일:', ar: 'ملف الصوت:', az: 'Səs Faylı:'
            },
            'select_sound_file': {
                tr: 'Ses Dosyası Seç', en: 'Select Sound File', de: 'Audiodatei auswählen', fr: 'Sélectionner un fichier audio', es: 'Seleccionar archivo de sonido', ru: 'Выбрать звуковой файл', zh: '选择音频文件', ja: '音声ファイルを選択', it: 'Seleziona file audio', pt: 'Selecionar arquivo de som', ko: '오디오 파일 선택', ar: 'اختر ملف الصوت', az: 'Səs Faylı Seç'
            },
            'background_color': {
                tr: 'Arka Plan Rengi:', en: 'Background Color:', de: 'Hintergrundfarbe:', fr: 'Couleur d\'arrière-plan:', es: 'Color de fondo:', ru: 'Цвет фона:', zh: '背景颜色:', ja: '背景色:', it: 'Colore di sfondo:', pt: 'Cor de fundo:', ko: '배경색:', ar: 'لون الخلفية:', az: 'Arxa Fon Rəngi:'
            },
            'text_color': {
                tr: 'Metin Rengi:', en: 'Text Color:', de: 'Textfarbe:', fr: 'Couleur du texte:', es: 'Color del texto:', ru: 'Цвет текста:', zh: '文字颜色:', ja: 'テキスト色:', it: 'Colore del testo:', pt: 'Cor do texto:', ko: '텍스트 색상:', ar: 'لون النص:', az: 'Mətn Rəngi:'
            },
            'border_color': {
                tr: 'Kenarlık Rengi:', en: 'Border Color:', de: 'Rahmenfarbe:', fr: 'Couleur de la bordure:', es: 'Color del borde:', ru: 'Цвет границы:', zh: '边框颜色:', ja: '境界線の色:', it: 'Colore del bordo:', pt: 'Cor da borda:', ko: '테두리 색상:', ar: 'لون الحدود:', az: 'Sərhəd Rəngi:'
            },
            'test': {
                tr: 'Test:', en: 'Test:', de: 'Test:', fr: 'Test:', es: 'Prueba:', ru: 'Тест:', zh: '测试:', ja: 'テスト:', it: 'Test:', pt: 'Teste:', ko: '테스트:', ar: 'اختبار:', az: 'Test:'
            },
            'success': {
                tr: 'Başarı', en: 'Success', de: 'Erfolg', fr: 'Succès', es: 'Éxito', ru: 'Успех', zh: '成功', ja: '成功', it: 'Successo', pt: 'Sucesso', ko: '성공', ar: 'نجاح', az: 'Uğur'
            },
            'error': {
                tr: 'Hata', en: 'Error', de: 'Fehler', fr: 'Erreur', es: 'Error', ru: 'Ошибка', zh: '错误', ja: 'エラー', it: 'Errore', pt: 'Erro', ko: '오류', ar: 'خطأ', az: 'Xəta'
            },
            'warning': {
                tr: 'Uyarı', en: 'Warning', de: 'Warnung', fr: 'Avertissement', es: 'Advertencia', ru: 'Предупреждение', zh: '警告', ja: '警告', it: 'Avviso', pt: 'Aviso', ko: '경고', ar: 'تحذير', az: 'Xəbərdarlıq'
            },
            'info': {
                tr: 'Bilgi', en: 'Info', de: 'Info', fr: 'Info', es: 'Info', ru: 'Информация', zh: '信息', ja: '情報', it: 'Info', pt: 'Info', ko: '정보', ar: 'معلومات', az: 'Məlumat'
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
            'steam_path_required': {
                tr: 'Steam Yolu Gerekli', en: 'Steam Path Required', de: 'Steam-Pfad erforderlich', fr: 'Chemin Steam requis', es: 'Ruta de Steam requerida', ru: 'Требуется путь Steam', zh: '需要Steam路径', ja: 'Steamパスが必要', it: 'Percorso Steam richiesto', pt: 'Caminho Steam necessário', ko: 'Steam 경로 필요', ar: 'مطلوب مسار Steam', az: 'Steam yolu tələb olunur'
            },
            'steam_path_not_set': {
                tr: 'Steam yolu ayarlanmamış.', en: 'Steam path is not set.', de: 'Steam-Pfad ist nicht eingestellt.', fr: 'Le chemin Steam n\'est pas défini.', es: 'La ruta de Steam no está configurada.', ru: 'Путь Steam не установлен.', zh: 'Steam路径未设置。', ja: 'Steamパスが設定されていません。', it: 'Il percorso Steam non è impostato.', pt: 'O caminho Steam não está definido.', ko: 'Steam 경로가 설정되지 않았습니다.', ar: 'مسار Steam غير محدد.', az: 'Steam yolu təyin edilməyib.'
            },
            'steam_path_required_for_games': {
                tr: 'Oyunları kütüphaneye eklemek için Steam yolu gereklidir.', en: 'Steam path is required to add games to library.', de: 'Steam-Pfad ist erforderlich, um Spiele zur Bibliothek hinzuzufügen.', fr: 'Le chemin Steam est requis pour ajouter des jeux à la bibliothèque.', es: 'La ruta de Steam es necesaria para añadir juegos a la biblioteca.', ru: 'Путь Steam необходим для добавления игр в библиотеку.', zh: '需要Steam路径才能将游戏添加到库中。', ja: 'ゲームをライブラリに追加するにはSteamパスが必要です。', it: 'Il percorso Steam è necessario per aggiungere giochi alla libreria.', pt: 'O caminho Steam é necessário para adicionar jogos à biblioteca.', ko: '게임을 라이브러리에 추가하려면 Steam 경로가 필요합니다.', ar: 'مطلوب مسار Steam لإضافة الألعاب إلى المكتبة.', az: 'Oyunları kitabxanaya əlavə etmək üçün Steam yolu tələb olunur.'
            },
            'select_steam_path': {
                tr: 'Steam Yolunu Seç', en: 'Select Steam Path', de: 'Steam-Pfad auswählen', fr: 'Sélectionner le chemin Steam', es: 'Seleccionar ruta de Steam', ru: 'Выбрать путь Steam', zh: '选择Steam路径', ja: 'Steamパスを選択', it: 'Seleziona percorso Steam', pt: 'Selecionar caminho Steam', ko: 'Steam 경로 선택', ar: 'اختر مسار Steam', az: 'Steam yolunu seç'
            },
            'later': {
                tr: 'Daha Sonra', en: 'Later', de: 'Später', fr: 'Plus tard', es: 'Más tarde', ru: 'Позже', zh: '稍后', ja: '後で', it: 'Più tardi', pt: 'Mais tarde', ko: '나중에', ar: 'لاحقاً', az: 'Daha sonra'
            },
            'hid_dll_missing': {
                tr: 'hid.dll Dosyası Eksik', en: 'hid.dll File Missing', de: 'hid.dll-Datei fehlt', fr: 'Fichier hid.dll manquant', es: 'Archivo hid.dll faltante', ru: 'Отсутствует файл hid.dll', zh: '缺少hid.dll文件', ja: 'hid.dllファイルが見つかりません', it: 'File hid.dll mancante', pt: 'Arquivo hid.dll ausente', ko: 'hid.dll 파일 누락', ar: 'ملف hid.dll مفقود', az: 'hid.dll faylı yoxdur'
            },
            'hid_dll_not_found': {
                tr: 'Steam klasörünüzde hid.dll dosyası bulunamadı.', en: 'hid.dll file not found in your Steam folder.', de: 'hid.dll-Datei nicht in Ihrem Steam-Ordner gefunden.', fr: 'Fichier hid.dll introuvable dans votre dossier Steam.', es: 'Archivo hid.dll no encontrado en su carpeta de Steam.', ru: 'Файл hid.dll не найден в папке Steam.', zh: '在您的Steam文件夹中未找到hid.dll文件。', ja: 'Steamフォルダにhid.dllファイルが見つかりません。', it: 'File hid.dll non trovato nella cartella Steam.', pt: 'Arquivo hid.dll não encontrado na sua pasta Steam.', ko: 'Steam 폴더에서 hid.dll 파일을 찾을 수 없습니다.', ar: 'ملف hid.dll غير موجود في مجلد Steam الخاص بك.', az: 'Steam qovluğunuzda hid.dll faylı tapılmadı.'
            },
            'hid_dll_required_for_games': {
                tr: 'Bu dosya olmadan oyunlar Steam kütüphanenizde görünmez.', en: 'Without this file, games will not appear in your Steam library.', de: 'Ohne diese Datei werden Spiele nicht in Ihrer Steam-Bibliothek angezeigt.', fr: 'Sans ce fichier, les jeux n\'apparaîtront pas dans votre bibliothèque Steam.', es: 'Sin este archivo, los juegos no aparecerán en su biblioteca de Steam.', ru: 'Без этого файла игры не появятся в вашей библиотеке Steam.', zh: '没有此文件，游戏将不会出现在您的Steam库中。', ja: 'このファイルがないと、ゲームはSteamライブラリに表示されません。', it: 'Senza questo file, i giochi non appariranno nella tua libreria Steam.', pt: 'Sem este arquivo, os jogos não aparecerão na sua biblioteca Steam.', ko: '이 파일이 없으면 게임이 Steam 라이브러리에 표시되지 않습니다.', ar: 'بدون هذا الملف، لن تظهر الألعاب في مكتبة Steam الخاصة بك.', az: 'Bu fayl olmadan oyunlar Steam kitabxananızda görünməyəcək.'
            },
            'important_note': {
                tr: 'Önemli Not:', en: 'Important Note:', de: 'Wichtiger Hinweis:', fr: 'Note importante:', es: 'Nota importante:', ru: 'Важное примечание:', zh: '重要提示:', ja: '重要な注意:', it: 'Nota importante:', pt: 'Nota importante:', ko: '중요한 참고사항:', ar: 'ملاحظة مهمة:', az: 'Vacib qeyd:'
            },
            'hid_dll_source_warning': {
                tr: 'hid.dll dosyası Steam Tools tarafından sağlanmıştır.', en: 'hid.dll file is provided by Steam Tools.', de: 'hid.dll-Datei wird von Steam Tools bereitgestellt.', fr: 'Le fichier hid.dll est fourni par Steam Tools.', es: 'El archivo hid.dll es proporcionado por Steam Tools.', ru: 'Файл hid.dll предоставляется Steam Tools.', zh: 'hid.dll文件由Steam Tools提供。', ja: 'hid.dllファイルはSteam Toolsによって提供されています。', it: 'Il file hid.dll è fornito da Steam Tools.', pt: 'O arquivo hid.dll é fornecido pelo Steam Tools.', ko: 'hid.dll 파일은 Steam Tools에서 제공됩니다.', ar: 'ملف hid.dll مقدم من Steam Tools.', az: 'hid.dll faylı Steam Tools tərəfindən təmin edilir.'
            },
            'hid_dll_no_responsibility': {
                tr: 'Hiçbir sorumluluk kabul edilmez.', en: 'No responsibility is accepted.', de: 'Es wird keine Verantwortung übernommen.', fr: 'Aucune responsabilité n\'est acceptée.', es: 'No se acepta ninguna responsabilidad.', ru: 'Никакая ответственность не принимается.', zh: '不承担任何责任。', ja: '責任は一切負いません。', it: 'Nessuna responsabilità è accettata.', pt: 'Nenhuma responsabilidade é aceita.', ko: '책임을 지지 않습니다.', ar: 'لا يتم قبول أي مسؤولية.', az: 'Heç bir məsuliyyət qəbul edilmir.'
            },
            'hid_dll_manual_option': {
                tr: 'İsterseniz kendiniz de hid.dll dosyasını atabilirsiniz.', en: 'You can also manually place the hid.dll file if you prefer.', de: 'Sie können die hid.dll-Datei auch manuell platzieren, wenn Sie es bevorzugen.', fr: 'Vous pouvez également placer manuellement le fichier hid.dll si vous préférez.', es: 'También puede colocar manualmente el archivo hid.dll si lo prefiere.', ru: 'Вы также можете вручную поместить файл hid.dll, если предпочитаете.', zh: '如果您愿意，也可以手动放置hid.dll文件。', ja: 'ご希望の場合は、hid.dllファイルを手動で配置することもできます。', it: 'Puoi anche posizionare manualmente il file hid.dll se preferisci.', pt: 'Você também pode colocar manualmente o arquivo hid.dll se preferir.', ko: '원하시면 hid.dll 파일을 수동으로 배치할 수도 있습니다.', ar: 'يمكنك أيضًا وضع ملف hid.dll يدويًا إذا كنت تفضل ذلك.', az: 'İstəsəniz hid.dll faylını özünüz də yerləşdirə bilərsiniz.'
            },
            
            'paradise_steam_library': {
                tr: 'Paradise Steam Library', en: 'Paradise Steam Library', de: 'Paradise Steam Library', fr: 'Paradise Steam Library', es: 'Paradise Steam Library', ru: 'Paradise Steam Library', zh: 'Paradise Steam Library', ja: 'Paradise Steam Library', it: 'Paradise Steam Library', pt: 'Paradise Steam Library', ko: 'Paradise Steam Library', ar: 'Paradise Steam Library', az: 'Paradise Steam Library'
            },
            'login_to_account': {
                tr: 'Hesabınıza giriş yapın', en: 'Sign in to your account', de: 'Melden Sie sich bei Ihrem Konto an', fr: 'Connectez-vous à votre compte', es: 'Inicia sesión en tu cuenta', ru: 'Войдите в свой аккаунт', zh: '登录您的账户', ja: 'アカウントにサインイン', it: 'Accedi al tuo account', pt: 'Entre na sua conta', ko: '계정에 로그인', ar: 'تسجيل الدخول إلى حسابك', az: 'Hesabınıza daxil olun'
            },
            'username': {
                tr: 'Kullanıcı Adı', en: 'Username', de: 'Benutzername', fr: 'Nom d\'utilisateur', es: 'Nombre de usuario', ru: 'Имя пользователя', zh: '用户名', ja: 'ユーザー名', it: 'Nome utente', pt: 'Nome de usuário', ko: '사용자 이름', ar: 'اسم المستخدم', az: 'İstifadəçi adı'
            },
            'enter_username': {
                tr: 'Kullanıcı adınızı girin', en: 'Enter your username', de: 'Geben Sie Ihren Benutzernamen ein', fr: 'Entrez votre nom d\'utilisateur', es: 'Ingresa tu nombre de usuario', ru: 'Введите имя пользователя', zh: '输入您的用户名', ja: 'ユーザー名を入力', it: 'Inserisci il tuo nome utente', pt: 'Digite seu nome de usuário', ko: '사용자 이름을 입력하세요', ar: 'أدخل اسم المستخدم', az: 'İstifadəçi adınızı daxil edin'
            },
            'password': {
                tr: 'Şifre', en: 'Password', de: 'Passwort', fr: 'Mot de passe', es: 'Contraseña', ru: 'Пароль', zh: '密码', ja: 'パスワード', it: 'Password', pt: 'Senha', ko: '비밀번호', ar: 'كلمة المرور', az: 'Şifrə'
            },
            'enter_password': {
                tr: 'Şifrenizi girin', en: 'Enter your password', de: 'Geben Sie Ihr Passwort ein', fr: 'Entrez votre mot de passe', es: 'Ingresa tu contraseña', ru: 'Введите пароль', zh: '输入您的密码', ja: 'パスワードを入力', it: 'Inserisci la tua password', pt: 'Digite sua senha', ko: '비밀번호를 입력하세요', ar: 'أدخل كلمة المرور', az: 'Şifrənizi daxil edin'
            },
            'discord_login': {
                tr: 'Discord ile Giriş Yap', en: 'Login with Discord', de: 'Mit Discord anmelden', fr: 'Se connecter avec Discord', es: 'Iniciar sesión con Discord', ru: 'Войти через Discord', zh: '使用Discord登录', ja: 'Discordでログイン', it: 'Accedi con Discord', pt: 'Entrar com Discord', ko: 'Discord로 로그인', ar: 'تسجيل الدخول باستخدام Discord', az: 'Discord ilə giriş et'
            },
            'discord_login_info': {
                tr: 'Discord hesabınızla giriş yaparak sunucumuzdaki rollerinize göre erişim kazanın', en: 'Login with your Discord account to gain access based on your roles on our server', de: 'Melden Sie sich mit Ihrem Discord-Konto an, um basierend auf Ihren Rollen auf unserem Server Zugang zu erhalten', fr: 'Connectez-vous avec votre compte Discord pour accéder en fonction de vos rôles sur notre serveur', es: 'Inicia sesión con tu cuenta de Discord para obtener acceso según tus roles en nuestro servidor', ru: 'Войдите в свой аккаунт Discord, чтобы получить доступ в зависимости от ваших ролей на нашем сервере', zh: '使用您的Discord账户登录，根据您在我们服务器上的角色获得访问权限', ja: 'Discordアカウントでログインして、サーバーでの役割に基づいてアクセスを取得', it: 'Accedi con il tuo account Discord per ottenere l\'accesso in base ai tuoi ruoli sul nostro server', pt: 'Entre com sua conta Discord para obter acesso com base em seus papéis em nosso servidor', ko: 'Discord 계정으로 로그인하여 서버의 역할에 따라 액세스 권한을 얻으세요', ar: 'سجل الدخول بحساب Discord الخاص بك للحصول على الوصول بناءً على أدوارك في خادمنا', az: 'Discord hesabınızla giriş edin və sunucumuzdakı rollarınıza əsaslanaraq giriş əldə edin'
            },
            'discord_info': {
                tr: 'Sunucumuzda bulunmanız ve gerekli rollere sahip olmanız gerekmektedir', en: 'You must be on our server and have the necessary roles', de: 'Sie müssen auf unserem Server sein und die notwendigen Rollen haben', fr: 'Vous devez être sur notre serveur et avoir les rôles nécessaires', es: 'Debes estar en nuestro servidor y tener los roles necesarios', ru: 'Вы должны быть на нашем сервере и иметь необходимые роли', zh: '您必须在我们的服务器上并拥有必要的角色', ja: 'サーバーにいる必要があり、必要な役割を持っている必要があります', it: 'Devi essere sul nostro server e avere i ruoli necessari', pt: 'Você deve estar em nosso servidor e ter os papéis necessários', ko: '서버에 있어야 하고 필요한 역할을 가져야 합니다', ar: 'يجب أن تكون في خادمنا ولديك الأدوار الضرورية', az: 'Sunucumuzda olmalısınız və lazımi rollara sahib olmalısınız'
            },
            'login': {
                tr: 'Giriş Yap', en: 'Sign In', de: 'Anmelden', fr: 'Se connecter', es: 'Iniciar sesión', ru: 'Войти', zh: '登录', ja: 'サインイン', it: 'Accedi', pt: 'Entrar', ko: '로그인', ar: 'تسجيل الدخول', az: 'Daxil ol'
            },
            'no_account': {
                tr: 'Hesabınız yok mu?', en: 'Don\'t have an account?', de: 'Haben Sie kein Konto?', fr: 'Vous n\'avez pas de compte ?', es: '¿No tienes una cuenta?', ru: 'Нет аккаунта?', zh: '没有账户？', ja: 'アカウントをお持ちでない方', it: 'Non hai un account?', pt: 'Não tem uma conta?', ko: '계정이 없으신가요?', ar: 'ليس لديك حساب؟', az: 'Hesabınız yoxdur?'
            },
            'register_on_site': {
                tr: 'Sitemize Kayıt Ol', en: 'Register on our site', de: 'Registrieren Sie sich auf unserer Website', fr: 'Inscrivez-vous sur notre site', es: 'Regístrate en nuestro sitio', ru: 'Зарегистрируйтесь на нашем сайте', zh: '在我们的网站注册', ja: '当サイトで登録', it: 'Registrati sul nostro sito', pt: 'Registre-se em nosso site', ko: '저희 사이트에서 가입하세요', ar: 'سجل في موقعنا', az: 'Saytımızda qeydiyyatdan keçin'
            },
            'login_error': {
                tr: 'Giriş bilgileri hatalı', en: 'Invalid login credentials', de: 'Ungültige Anmeldedaten', fr: 'Identifiants de connexion invalides', es: 'Credenciales de inicio de sesión inválidas', ru: 'Неверные данные для входа', zh: '登录凭据无效', ja: 'ログイン情報が無効です', it: 'Credenziali di accesso non valide', pt: 'Credenciais de login inválidas', ko: '잘못된 로그인 정보', ar: 'بيانات تسجيل الدخول غير صحيحة', az: 'Giriş məlumatları yanlışdır'
            },
            'active': {
                tr: 'aktif', en: 'active', de: 'aktiv', fr: 'actif', es: 'activo', ru: 'активен', zh: '活跃', ja: 'アクティブ', it: 'attivo', pt: 'ativo', ko: '활성', ar: 'نشط', az: 'aktiv'
            },
            'language': {
                tr: 'Dil', en: 'Language', de: 'Sprache', fr: 'Langue', es: 'Idioma', ru: 'Язык', zh: '语言', ja: '言語', it: 'Lingua', pt: 'Idioma', ko: '언어', ar: 'اللغة', az: 'Dil'
            },
            'select_language': {
                tr: 'Dil Seçin', en: 'Select Language', de: 'Sprache auswählen', fr: 'Sélectionner la langue', es: 'Seleccionar idioma', ru: 'Выберите язык', zh: '选择语言', ja: '言語を選択', it: 'Seleziona lingua', pt: 'Selecionar idioma', ko: '언어 선택', ar: 'اختر اللغة', az: 'Dil seçin'
            },
            'download_hid_dll': {
                tr: 'hid.dll İndir', en: 'Download hid.dll', de: 'hid.dll herunterladen', fr: 'Télécharger hid.dll', es: 'Descargar hid.dll', ru: 'Скачать hid.dll', zh: '下载hid.dll', ja: 'hid.dllをダウンロード', it: 'Scarica hid.dll', pt: 'Baixar hid.dll', ko: 'hid.dll 다운로드', ar: 'تحميل hid.dll', az: 'hid.dll yüklə'
            },
            'close_program': {
                tr: 'Programı Kapat', en: 'Close Program', de: 'Programm schließen', fr: 'Fermer le programme', es: 'Cerrar programa', ru: 'Закрыть программу', zh: '关闭程序', ja: 'プログラムを閉じる', it: 'Chiudi programma', pt: 'Fechar programa', ko: '프로그램 닫기', ar: 'إغلاق البرنامج', az: 'Proqramı bağla'
            },
            'notification_settings': {
                tr: 'Bildirim Ayarları', en: 'Notification Settings', de: 'Benachrichtigungseinstellungen', fr: 'Paramètres de notification', es: 'Configuración de notificaciones', ru: 'Настройки уведомлений', zh: '通知设置', ja: '通知設定', it: 'Impostazioni notifiche', pt: 'Configurações de notificação', ko: '알림 설정', ar: 'إعدادات الإشعارات', az: 'Bildiriş parametrləri'
            },
            'notification_theme': {
                tr: 'Bildirim Teması', en: 'Notification Theme', de: 'Benachrichtigungsthema', fr: 'Thème de notification', es: 'Tema de notificación', ru: 'Тема уведомлений', zh: '通知主题', ja: '通知テーマ', it: 'Tema notifiche', pt: 'Tema de notificação', ko: '알림 테마', ar: 'مظهر الإشعارات', az: 'Bildiriş teması'
            },
            'notification_position': {
                tr: 'Bildirim Konumu', en: 'Notification Position', de: 'Benachrichtigungsposition', fr: 'Position de notification', es: 'Posición de notificación', ru: 'Позиция уведомлений', zh: '通知位置', ja: '通知位置', it: 'Posizione notifiche', pt: 'Posição da notificação', ko: '알림 위치', ar: 'موضع الإشعارات', az: 'Bildiriş mövqeyi'
            },
            'notification_duration': {
                tr: 'Bildirim Süresi (saniye)', en: 'Notification Duration (seconds)', de: 'Benachrichtigungsdauer (Sekunden)', fr: 'Durée de notification (secondes)', es: 'Duración de notificación (segundos)', ru: 'Длительность уведомлений (секунды)', zh: '通知持续时间（秒）', ja: '通知時間（秒）', it: 'Durata notifiche (secondi)', pt: 'Duração da notificação (segundos)', ko: '알림 지속 시간 (초)', ar: 'مدة الإشعارات (ثوانٍ)', az: 'Bildiriş müddəti (saniyə)'
            },
            'notification_animation': {
                tr: 'Bildirim Animasyonu', en: 'Notification Animation', de: 'Benachrichtigungsanimation', fr: 'Animation de notification', es: 'Animación de notificación', ru: 'Анимация уведомлений', zh: '通知动画', ja: '通知アニメーション', it: 'Animazione notifiche', pt: 'Animação da notificação', ko: '알림 애니메이션', ar: 'رسوم متحركة الإشعارات', az: 'Bildiriş animasiyası'
            },
            'notification_sound': {
                tr: 'Bildirim Sesi', en: 'Notification Sound', de: 'Benachrichtigungston', fr: 'Son de notification', es: 'Sonido de notificación', ru: 'Звук уведомлений', zh: '通知声音', ja: '通知音', it: 'Suono notifiche', pt: 'Som da notificação', ko: '알림 소리', ar: 'صوت الإشعارات', az: 'Bildiriş səsi'
            },
            'enable_sound': {
                tr: 'Ses Efekti Etkinleştir', en: 'Enable Sound Effect', de: 'Soundeffekt aktivieren', fr: 'Activer l\'effet sonore', es: 'Habilitar efecto de sonido', ru: 'Включить звуковой эффект', zh: '启用音效', ja: '音響効果を有効にする', it: 'Abilita effetto sonoro', pt: 'Ativar efeito sonoro', ko: '음향 효과 활성화', ar: 'تفعيل التأثير الصوتي', az: 'Səs effektini aktivləşdir'
            },
            'notification_preview': {
                tr: 'Bildirim Önizleme', en: 'Notification Preview', de: 'Benachrichtigungsvorschau', fr: 'Aperçu de notification', es: 'Vista previa de notificación', ru: 'Предварительный просмотр уведомлений', zh: '通知预览', ja: '通知プレビュー', it: 'Anteprima notifiche', pt: 'Visualização da notificação', ko: '알림 미리보기', ar: 'معاينة الإشعارات', az: 'Bildiriş önizləməsi'
            },
            'preview_success': {
                tr: 'Başarı Önizleme', en: 'Success Preview', de: 'Erfolgsvorschau', fr: 'Aperçu de succès', es: 'Vista previa de éxito', ru: 'Предварительный просмотр успеха', zh: '成功预览', ja: '成功プレビュー', it: 'Anteprima successo', pt: 'Visualização de sucesso', ko: '성공 미리보기', ar: 'معاينة النجاح', az: 'Uğur önizləməsi'
            },
            'preview_error': {
                tr: 'Hata Önizleme', en: 'Error Preview', de: 'Fehlervorschau', fr: 'Aperçu d\'erreur', es: 'Vista previa de error', ru: 'Предварительный просмотр ошибки', zh: '错误预览', ja: 'エラープレビュー', it: 'Anteprima errore', pt: 'Visualização de erro', ko: '오류 미리보기', ar: 'معاينة الخطأ', az: 'Xəta önizləməsi'
            },
            'preview_warning': {
                tr: 'Uyarı Önizleme', en: 'Warning Preview', de: 'Warnungsvorschau', fr: 'Aperçu d\'avertissement', es: 'Vista previa de advertencia', ru: 'Предварительный просмотр предупреждения', zh: '警告预览', ja: '警告プレビュー', it: 'Anteprima avviso', pt: 'Visualização de aviso', ko: '경고 미리보기', ar: 'معاينة التحذير', az: 'Xəbərdarlıq önizləməsi'
            },
            'preview_info': {
                tr: 'Bilgi Önizleme', en: 'Info Preview', de: 'Informationsvorschau', fr: 'Aperçu d\'information', es: 'Vista previa de información', ru: 'Предварительный просмотр информации', zh: '信息预览', ja: '情報プレビュー', it: 'Anteprima informazioni', pt: 'Visualização de informações', ko: '정보 미리보기', ar: 'معاينة المعلومات', az: 'Məlumat önizləməsi'
            },
            'notification_colors': {
                tr: 'Renk Özelleştirme', en: 'Color Customization', de: 'Farbanpassung', fr: 'Personnalisation des couleurs', es: 'Personalización de colores', ru: 'Настройка цветов', zh: '颜色自定义', ja: '色のカスタマイズ', it: 'Personalizzazione colori', pt: 'Personalização de cores', ko: '색상 사용자 정의', ar: 'تخصيص الألوان', az: 'Rəng fərdiləşdirməsi'
            },
            'advanced_settings': {
                tr: 'Gelişmiş Ayarlar', en: 'Advanced Settings', de: 'Erweiterte Einstellungen', fr: 'Paramètres avancés', es: 'Configuración avanzada', ru: 'Расширенные настройки', zh: '高级设置', ja: '詳細設定', it: 'Impostazioni avanzate', pt: 'Configurações avançadas', ko: '고급 설정', ar: 'الإعدادات المتقدمة', az: 'Təkmilləşdirilmiş parametrlər'
            },
            'advanced_notification_settings': {
                tr: 'Gelişmiş Bildirim Ayarları', en: 'Advanced Notification Settings', de: 'Erweiterte Benachrichtigungseinstellungen', fr: 'Paramètres de notification avancés', es: 'Configuración avanzada de notificaciones', ru: 'Расширенные настройки уведомлений', zh: '高级通知设置', ja: '詳細通知設定', it: 'Impostazioni notifiche avanzate', pt: 'Configurações avançadas de notificação', ko: '고급 알림 설정', ar: 'إعدادات الإشعارات المتقدمة', az: 'Təkmilləşdirilmiş bildiriş parametrləri'
            },
            'settings_management': {
                tr: 'Ayarları Yönet', en: 'Settings Management', de: 'Einstellungen verwalten', fr: 'Gestion des paramètres', es: 'Gestión de configuración', ru: 'Управление настройками', zh: '设置管理', ja: '設定管理', it: 'Gestione impostazioni', pt: 'Gerenciamento de configurações', ko: '설정 관리', ar: 'إدارة الإعدادات', az: 'Parametrləri idarə et'
            },
            'reset_to_default': {
                tr: 'Varsayılana Al', en: 'Reset to Default', de: 'Auf Standard zurücksetzen', fr: 'Remettre par défaut', es: 'Restablecer por defecto', ru: 'Сбросить по умолчанию', zh: '重置为默认', ja: 'デフォルトにリセット', it: 'Ripristina predefiniti', pt: 'Redefinir para padrão', ko: '기본값으로 재설정', ar: 'إعادة تعيين إلى الافتراضي', az: 'Varsayılana qaytar'
            },
            'export_settings': {
                tr: 'Dışa Aktar', en: 'Export Settings', de: 'Einstellungen exportieren', fr: 'Exporter les paramètres', es: 'Exportar configuración', ru: 'Экспорт настроек', zh: '导出设置', ja: '設定をエクスポート', it: 'Esporta impostazioni', pt: 'Exportar configurações', ko: '설정 내보내기', ar: 'تصدير الإعدادات', az: 'Parametrləri ixrac et'
            },
            'import_settings': {
                tr: 'İçe Aktar', en: 'Import Settings', de: 'Einstellungen importieren', fr: 'Importer les paramètres', es: 'Importar configuración', ru: 'Импорт настроек', zh: '导入设置', ja: '設定をインポート', it: 'Importa impostazioni', pt: 'Importar configurações', ko: '설정 가져오기', ar: 'استيراد الإعدادات', az: 'Parametrləri idxal et'
            },
            'sound_on': {
                tr: 'AÇIK', en: 'ON', de: 'EIN', fr: 'ACTIVÉ', es: 'ENCENDIDO', ru: 'ВКЛ', zh: '开启', ja: 'オン', it: 'ACCESO', pt: 'LIGADO', ko: '켜짐', ar: 'تشغيل', az: 'AÇIQ'
            },
            'sound_off': {
                tr: 'KAPALI', en: 'OFF', de: 'AUS', fr: 'DÉSACTIVÉ', es: 'APAGADO', ru: 'ВЫКЛ', zh: '关闭', ja: 'オフ', it: 'SPENTO', pt: 'DESLIGADO', ko: '꺼짐', ar: 'إيقاف', az: 'BAĞLI'
            },
            'style_modern': {
                tr: 'Modern', en: 'Modern', de: 'Modern', fr: 'Moderne', es: 'Moderno', ru: 'Современный', zh: '现代', ja: 'モダン', it: 'Moderno', pt: 'Moderno', ko: '모던', ar: 'حديث', az: 'Müasir'
            },
            'style_neon': {
                tr: 'Neon', en: 'Neon', de: 'Neon', fr: 'Néon', es: 'Neón', ru: 'Неон', zh: '霓虹', ja: 'ネオン', it: 'Neon', pt: 'Neon', ko: '네온', ar: 'نيون', az: 'Neon'
            },
            'style_glass': {
                tr: 'Cam Efekti', en: 'Glass Effect', de: 'Glaseffekt', fr: 'Effet de verre', es: 'Efecto cristal', ru: 'Стеклянный эффект', zh: '玻璃效果', ja: 'ガラス効果', it: 'Effetto vetro', pt: 'Efeito vidro', ko: '유리 효과', ar: 'تأثير الزجاج', az: 'Şüşə effekti'
            },
            'style_retro': {
                tr: 'Retro', en: 'Retro', de: 'Retro', fr: 'Rétro', es: 'Retro', ru: 'Ретро', zh: '复古', ja: 'レトロ', it: 'Retro', pt: 'Retrô', ko: '레트로', ar: 'رترو', az: 'Retro'
            },
            'style_steampunk': {
                tr: 'Steampunk', en: 'Steampunk', de: 'Steampunk', fr: 'Steampunk', es: 'Steampunk', ru: 'Стимпанк', zh: '蒸汽朋克', ja: 'スチームパンク', it: 'Steampunk', pt: 'Steampunk', ko: '스팀펑크', ar: 'ستيم بانك', az: 'Steampunk'
            },
            'style_hologram': {
                tr: 'Hologram', en: 'Hologram', de: 'Hologramm', fr: 'Hologramme', es: 'Holograma', ru: 'Голограмма', zh: '全息图', ja: 'ホログラム', it: 'Ologramma', pt: 'Holograma', ko: '홀로그램', ar: 'هولوغرام', az: 'Holoqram'
            },
            'style_matrix': {
                tr: 'Matrix', en: 'Matrix', de: 'Matrix', fr: 'Matrice', es: 'Matrix', ru: 'Матрица', zh: '矩阵', ja: 'マトリックス', it: 'Matrix', pt: 'Matrix', ko: '매트릭스', ar: 'ماتريكس', az: 'Matrix'
            },
            'style_gradient': {
                tr: 'Gradient', en: 'Gradient', de: 'Farbverlauf', fr: 'Dégradé', es: 'Degradado', ru: 'Градиент', zh: '渐变', ja: 'グラデーション', it: 'Gradiente', pt: 'Gradiente', ko: '그라데이션', ar: 'تدرج', az: 'Qradiyent'
            },
            'style_minimal': {
                tr: 'Minimal', en: 'Minimal', de: 'Minimal', fr: 'Minimal', es: 'Minimal', ru: 'Минимальный', zh: '极简', ja: 'ミニマル', it: 'Minimale', pt: 'Minimal', ko: '미니멀', ar: 'أدنى', az: 'Minimal'
            },
            'style_cosmic': {
                tr: 'Kozmik', en: 'Cosmic', de: 'Kosmisch', fr: 'Cosmique', es: 'Cósmico', ru: 'Космический', zh: '宇宙', ja: 'コスミック', it: 'Cosmico', pt: 'Cósmico', ko: '우주', ar: 'كوني', az: 'Kosmik'
            },
            'style_fire': {
                tr: 'Ateş', en: 'Fire', de: 'Feuer', fr: 'Feu', es: 'Fuego', ru: 'Огонь', zh: '火焰', ja: '炎', it: 'Fuoco', pt: 'Fogo', ko: '불', ar: 'نار', az: 'Alov'
            },
            'style_ice': {
                tr: 'Buz', en: 'Ice', de: 'Eis', fr: 'Glace', es: 'Hielo', ru: 'Лёд', zh: '冰', ja: '氷', it: 'Ghiaccio', pt: 'Gelo', ko: '얼음', ar: 'جليد', az: 'Buz'
            },
            'style_golden': {
                tr: 'Altın', en: 'Golden', de: 'Golden', fr: 'Doré', es: 'Dorado', ru: 'Золотой', zh: '金色', ja: 'ゴールデン', it: 'Dorato', pt: 'Dourado', ko: '황금', ar: 'ذهبي', az: 'Qızıl'
            },
            'style_vintage': {
                tr: 'Vintage', en: 'Vintage', de: 'Vintage', fr: 'Vintage', es: 'Vintage', ru: 'Винтаж', zh: '复古', ja: 'ヴィンテージ', it: 'Vintage', pt: 'Vintage', ko: '빈티지', ar: 'قديم', az: 'Vintage'
            },
            'style_futuristic': {
                tr: 'Futuristik', en: 'Futuristic', de: 'Futuristisch', fr: 'Futuriste', es: 'Futurista', ru: 'Футуристический', zh: '未来', ja: '未来的', it: 'Futuristico', pt: 'Futurista', ko: '미래적', ar: 'مستقبلي', az: 'Futuristik'
            },
            'version': {
                tr: 'Sürüm:', en: 'Version:', de: 'Version:', fr: 'Version:', es: 'Versión:', ru: 'Версия:', zh: '版本:', ja: 'バージョン:', it: 'Versione:', pt: 'Versão:', ko: '버전:', ar: 'الإصدار:', az: 'Versiya:'
            },
            'loading': {
                tr: 'Yükleniyor...', en: 'Loading...', de: 'Lädt...', fr: 'Chargement...', es: 'Cargando...', ru: 'Загрузка...', zh: '加载中...', ja: '読み込み中...', it: 'Caricamento...', pt: 'Carregando...', ko: '로딩 중...', ar: 'جاري التحميل...', az: 'Yüklənir...'
            },
            'github': {
                tr: 'GitHub', en: 'GitHub', de: 'GitHub', fr: 'GitHub', es: 'GitHub', ru: 'GitHub', zh: 'GitHub', ja: 'GitHub', it: 'GitHub', pt: 'GitHub', ko: 'GitHub', ar: 'GitHub', az: 'GitHub'
            },
            'select_sound_file': {
                tr: 'Ses Dosyası Seç', en: 'Select Sound File', de: 'Tondatei auswählen', fr: 'Sélectionner un fichier audio', es: 'Seleccionar archivo de sonido', ru: 'Выбрать звуковой файл', zh: '选择声音文件', ja: '音声ファイルを選択', it: 'Seleziona file audio', pt: 'Selecionar arquivo de som', ko: '사운드 파일 선택', ar: 'اختر ملف الصوت', az: 'Səs faylı seç'
            },
            'save_notification_settings': {
                tr: 'Bildirim Ayarlarını Kaydet', en: 'Save Notification Settings', de: 'Benachrichtigungseinstellungen speichern', fr: 'Enregistrer les paramètres de notification', es: 'Guardar configuración de notificaciones', ru: 'Сохранить настройки уведомлений', zh: '保存通知设置', ja: '通知設定を保存', it: 'Salva impostazioni notifiche', pt: 'Salvar configurações de notificação', ko: '알림 설정 저장', ar: 'حفظ إعدادات الإشعارات', az: 'Bildiriş parametrlərini saxla'
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
            'icon_customization': {
                tr: 'İkon Özelleştirme', en: 'Icon Customization', de: 'Symbol-Anpassung', fr: 'Personnalisation des icônes', es: 'Personalización de iconos', ru: 'Настройка иконок', zh: '图标自定义', ja: 'アイコンカスタマイズ', it: 'Personalizzazione icone', pt: 'Personalização de ícones', ko: '아이콘 사용자 정의', ar: 'تخصيص الأيقونات', az: 'İkon Fərdiləşdirmə'
            },
            'save': {
                tr: 'Kaydet', en: 'Save', de: 'Speichern', fr: 'Enregistrer', es: 'Guardar', ru: 'Сохранить', zh: '保存', ja: '保存', it: 'Salva', pt: 'Salvar', ko: '저장', ar: 'حفظ', az: 'Yadda saxla'
            },
            'reset': {
                tr: 'Sıfırla', en: 'Reset', de: 'Zurücksetzen', fr: 'Réinitialiser', es: 'Restablecer', ru: 'Сбросить', zh: '重置', ja: 'リセット', it: 'Ripristina', pt: 'Redefinir', ko: '재설정', ar: 'إعادة تعيين', az: 'Sıfırla'
            },
            'bubble_menu': {
                tr: 'Bubble Menü', en: 'Bubble Menu', de: 'Blasen-Menü', fr: 'Menu bulle', es: 'Menú burbuja', ru: 'Меню-пузырь', zh: '气泡菜单', ja: 'バブルメニュー', it: 'Menu a bolle', pt: 'Menu bolha', ko: '버블 메뉴', ar: 'قائمة الفقاعة', az: 'Bubble Menü'
            },
            'hamburger_menu': {
                tr: 'Hamburger Menü', en: 'Hamburger Menu', de: 'Hamburger-Menü', fr: 'Menu hamburger', es: 'Menú hamburguesa', ru: 'Гамбургер-меню', zh: '汉堡菜单', ja: 'ハンバーガーメニュー', it: 'Menu hamburger', pt: 'Menu hambúrguer', ko: '햄버거 메뉴', ar: 'قائمة الهامبرغر', az: 'Hamburger Menü'
            },
            'bubble_menu_icons': {
                tr: 'Bubble Menü İkonları', en: 'Bubble Menu Icons', de: 'Blasen-Menü-Symbole', fr: 'Icônes du menu bulle', es: 'Iconos del menú burbuja', ru: 'Иконки меню-пузыря', zh: '气泡菜单图标', ja: 'バブルメニューアイコン', it: 'Icone menu a bolle', pt: 'Ícones do menu bolha', ko: '버블 메뉴 아이콘', ar: 'أيقونات قائمة الفقاعة', az: 'Bubble Menü İkonları'
            },
            'home_icon': {
                tr: 'Ana Sayfa İkonu', en: 'Home Icon', de: 'Startseiten-Symbol', fr: 'Icône d\'accueil', es: 'Icono de inicio', ru: 'Иконка главной', zh: '首页图标', ja: 'ホームアイコン', it: 'Icona home', pt: 'Ícone inicial', ko: '홈 아이콘', ar: 'أيقونة الرئيسية', az: 'Ana Səhifə İkonu'
            },
            'icon': {
                tr: 'İkon', en: 'Icon', de: 'Symbol', fr: 'Icône', es: 'Icono', ru: 'Иконка', zh: '图标', ja: 'アイコン', it: 'Icona', pt: 'Ícone', ko: '아이콘', ar: 'أيقونة', az: 'İkon'
            },
            'background': {
                tr: 'Arka Plan', en: 'Background', de: 'Hintergrund', fr: 'Arrière-plan', es: 'Fondo', ru: 'Фон', zh: '背景', ja: '背景', it: 'Sfondo', pt: 'Fundo', ko: '배경', ar: 'الخلفية', az: 'Arxa Plan'
            },
            'line_color': {
                tr: 'Çizgi Rengi', en: 'Line Color', de: 'Linienfarbe', fr: 'Couleur de ligne', es: 'Color de línea', ru: 'Цвет линии', zh: '线条颜色', ja: '線の色', it: 'Colore linea', pt: 'Cor da linha', ko: '선 색상', ar: 'لون الخط', az: 'Xətt Rəngi'
            },
            'hover_color': {
                tr: 'Hover Rengi', en: 'Hover Color', de: 'Hover-Farbe', fr: 'Couleur de survol', es: 'Color de hover', ru: 'Цвет при наведении', zh: '悬停颜色', ja: 'ホバー色', it: 'Colore hover', pt: 'Cor de hover', ko: '호버 색상', ar: 'لون التمرير', az: 'Hover Rəngi'
            },
            'hover_background': {
                tr: 'Hover Arka Plan', en: 'Hover Background', de: 'Hover-Hintergrund', fr: 'Arrière-plan de survol', es: 'Fondo de hover', ru: 'Фон при наведении', zh: '悬停背景', ja: 'ホバー背景', it: 'Sfondo hover', pt: 'Fundo de hover', ko: '호버 배경', ar: 'الخلفية عند التمرير', az: 'Hover Arxa Plan'
            },
            'glow_effect': {
                tr: 'Glow Efekti', en: 'Glow Effect', de: 'Glühen-Effekt', fr: 'Effet de lueur', es: 'Efecto de resplandor', ru: 'Эффект свечения', zh: '发光效果', ja: 'グロー効果', it: 'Effetto bagliore', pt: 'Efeito brilho', ko: '글로우 효과', ar: 'تأثير التوهج', az: 'Glow Effekti'
            },
            'line_thickness': {
                tr: 'Çizgi Kalınlığı', en: 'Line Thickness', de: 'Linienbreite', fr: 'Épaisseur de ligne', es: 'Grosor de línea', ru: 'Толщина линии', zh: '线条粗细', ja: '線の太さ', it: 'Spessore linea', pt: 'Espessura da linha', ko: '선 두께', ar: 'سمك الخط', az: 'Xətt Qalınlığı'
            },
            'line_gap': {
                tr: 'Çizgi Aralığı', en: 'Line Gap', de: 'Linienabstand', fr: 'Espacement des lignes', es: 'Espacio entre líneas', ru: 'Расстояние между линиями', zh: '线条间距', ja: '線の間隔', it: 'Spazio tra linee', pt: 'Espaçamento entre linhas', ko: '선 간격', ar: 'المسافة بين الخطوط', az: 'Xətt Aralığı'
            },
            'hamburger_button': {
                tr: '☰ Hamburger Butonu', en: '☰ Hamburger Button', de: '☰ Hamburger-Button', fr: '☰ Bouton hamburger', es: '☰ Botón hamburguesa', ru: '☰ Кнопка-гамбургер', zh: '☰ 汉堡按钮', ja: '☰ ハンバーガーボタン', it: '☰ Pulsante hamburger', pt: '☰ Botão hambúrguer', ko: '☰ 햄버거 버튼', ar: '☰ زر الهامبرغر', az: '☰ Hamburger Düyməsi'
            },
            'repair_fix_icon': {
                tr: 'Çevrimiçi Düzeltme İkonu', en: 'Online Fix Icon', de: 'Online-Reparatur-Symbol', fr: 'Icône de correction en ligne', es: 'Icono de corrección en línea', ru: 'Иконка онлайн исправления', zh: '在线修复图标', ja: 'オンライン修正アイコン', it: 'Icona correzione online', pt: 'Ícone de correção online', ko: '온라인 수정 아이콘', ar: 'أيقونة التصحيح عبر الإنترنت', az: 'Onlayn Düzəliş İkonu'
            },
            'bypass_icon': {
                tr: 'Bypass İkonu', en: 'Bypass Icon', de: 'Bypass-Symbol', fr: 'Icône de bypass', es: 'Icono de bypass', ru: 'Иконка обхода', zh: '绕过图标', ja: 'バイパスアイコン', it: 'Icona bypass', pt: 'Ícone de bypass', ko: '우회 아이콘', ar: 'أيقونة الالتفاف', az: 'Bypass ikonu'
            },
            'bypass': {
                tr: 'Bypass', en: 'Bypass', de: 'Bypass', fr: 'Bypass', es: 'Bypass', ru: 'Обход', zh: '绕过', ja: 'バイパス', it: 'Bypass', pt: 'Bypass', ko: '우회', ar: 'التفاف', az: 'Bypass'
            },
            'loading_bypass_games': {
                tr: 'Bypass oyunları yükleniyor...', en: 'Loading bypass games...', de: 'Bypass-Spiele werden geladen...', fr: 'Chargement des jeux bypass...', es: 'Cargando juegos bypass...', ru: 'Загрузка игр обхода...', zh: '正在加载绕过游戏...', ja: 'バイパスゲームを読み込み中...', it: 'Caricamento giochi bypass...', pt: 'Carregando jogos bypass...', ko: '우회 게임 로딩 중...', ar: 'جاري تحميل ألعاب الالتفاف...', az: 'Bypass oyunları yüklənir...'
            },
            'discord_token_required': {
                tr: 'Discord token gerekli', en: 'Discord token required', de: 'Discord-Token erforderlich', fr: 'Token Discord requis', es: 'Token de Discord requerido', ru: 'Требуется токен Discord', zh: '需要Discord令牌', ja: 'Discordトークンが必要です', it: 'Token Discord richiesto', pt: 'Token do Discord necessário', ko: 'Discord 토큰 필요', ar: 'مطلوب رمز Discord', az: 'Discord token tələb olunur'
            },
            'installed': {
                tr: 'Kurulu', en: 'Installed', de: 'Installiert', fr: 'Installé', es: 'Instalado', ru: 'Установлено', zh: '已安装', ja: 'インストール済み', it: 'Installato', pt: 'Instalado', ko: '설치됨', ar: 'مثبت', az: 'Qurulub'
            },
            'remove_bypass': {
                tr: 'Bypass Kaldır', en: 'Remove Bypass', de: 'Bypass entfernen', fr: 'Supprimer le bypass', es: 'Eliminar bypass', ru: 'Убрать обход', zh: '移除绕过', ja: 'バイパスを削除', it: 'Rimuovi bypass', pt: 'Remover bypass', ko: '우회 제거', ar: 'إزالة الالتفاف', az: 'Bypass sil'
            },
            'ready': {
                tr: 'Hazır', en: 'Ready', de: 'Bereit', fr: 'Prêt', es: 'Listo', ru: 'Готово', zh: '就绪', ja: '準備完了', it: 'Pronto', pt: 'Pronto', ko: '준비됨', ar: 'جاهز', az: 'Hazır'
            },
            'download_bypass': {
                tr: 'Bypass İndir', en: 'Download Bypass', de: 'Bypass herunterladen', fr: 'Télécharger le bypass', es: 'Descargar bypass', ru: 'Скачать обход', zh: '下载绕过', ja: 'バイパスをダウンロード', it: 'Scarica bypass', pt: 'Baixar bypass', ko: '우회 다운로드', ar: 'تحميل الالتفاف', az: 'Bypass yüklə'
            },
            'downloading_bypass': {
                tr: 'Bypass indiriliyor...', en: 'Downloading bypass...', de: 'Bypass wird heruntergeladen...', fr: 'Téléchargement du bypass...', es: 'Descargando bypass...', ru: 'Скачивание обхода...', zh: '正在下载绕过...', ja: 'バイパスをダウンロード中...', it: 'Download del bypass...', pt: 'Baixando bypass...', ko: '우회 다운로드 중...', ar: 'جاري تحميل الالتفاف...', az: 'Bypass yüklənir...'
            },
            'bypass_installed': {
                tr: 'Bypass başarıyla kuruldu', en: 'Bypass installed successfully', de: 'Bypass erfolgreich installiert', fr: 'Bypass installé avec succès', es: 'Bypass instalado exitosamente', ru: 'Обход успешно установлен', zh: '绕过安装成功', ja: 'バイパスが正常にインストールされました', it: 'Bypass installato con successo', pt: 'Bypass instalado com sucesso', ko: '우회가 성공적으로 설치됨', ar: 'تم تثبيت الالتفاف بنجاح', az: 'Bypass uğurla quraşdırıldı'
            },
            'removing_bypass': {
                tr: 'Bypass kaldırılıyor...', en: 'Removing bypass...', de: 'Bypass wird entfernt...', fr: 'Suppression du bypass...', es: 'Eliminando bypass...', ru: 'Удаление обхода...', zh: '正在移除绕过...', ja: 'バイパスを削除中...', it: 'Rimozione del bypass...', pt: 'Removendo bypass...', ko: '우회 제거 중...', ar: 'جاري إزالة الالتفاف...', az: 'Bypass silinir...'
            },
            'bypass_removed': {
                tr: 'Bypass başarıyla kaldırıldı', en: 'Bypass removed successfully', de: 'Bypass erfolgreich entfernt', fr: 'Bypass supprimé avec succès', es: 'Bypass eliminado exitosamente', ru: 'Обход успешно удален', zh: '绕过移除成功', ja: 'バイパスが正常に削除されました', it: 'Bypass rimosso con successo', pt: 'Bypass removido com sucesso', ko: '우회가 성공적으로 제거됨', ar: 'تم إزالة الالتفاف بنجاح', az: 'Bypass uğurla silindi'
            },
            'no_bypass_found': {
                tr: 'Bypass bulunamadı', en: 'No bypass found', de: 'Kein Bypass gefunden', fr: 'Aucun bypass trouvé', es: 'No se encontró bypass', ru: 'Обход не найден', zh: '未找到绕过', ja: 'バイパスが見つかりません', it: 'Nessun bypass trovato', pt: 'Nenhum bypass encontrado', ko: '우회를 찾을 수 없음', ar: 'لم يتم العثور على الالتفاف', az: 'Bypass tapılmadı'
            },
            'no_bypass_info': {
                tr: 'Şu anda bypass dosyası bulunmuyor. Daha sonra tekrar kontrol edin.', en: 'No bypass files available at the moment. Please check back later.', de: 'Derzeit sind keine Bypass-Dateien verfügbar. Bitte schauen Sie später wieder vorbei.', fr: 'Aucun fichier bypass disponible pour le moment. Veuillez revenir plus tard.', es: 'No hay archivos bypass disponibles en este momento. Por favor, vuelva más tarde.', ru: 'В настоящее время файлы обхода недоступны. Пожалуйста, проверьте позже.', zh: '目前没有可用的绕过文件。请稍后再检查。', ja: '現在バイパスファイルは利用できません。後でもう一度確認してください。', it: 'Nessun file bypass disponibile al momento. Riprova più tardi.', pt: 'Nenhum arquivo bypass disponível no momento. Por favor, verifique mais tarde.', ko: '현재 사용할 수 있는 우회 파일이 없습니다. 나중에 다시 확인해 주세요.', ar: 'لا توجد ملفات الالتفاف متاحة في الوقت الحالي. يرجى التحقق مرة أخرى لاحقًا.', az: 'Hal-hazırda bypass faylları mövcud deyil. Zəhmət olmasa daha sonra yoxlayın.'
            },
            'fetching_bypass_database': {
                tr: 'Bypass veritabanından oyunlar alınıyor...', en: 'Fetching games from bypass database...', de: 'Spiele werden aus der Bypass-Datenbank abgerufen...', fr: 'Récupération des jeux depuis la base de données bypass...', es: 'Obteniendo juegos de la base de datos bypass...', ru: 'Получение игр из базы данных обхода...', zh: '从绕过数据库获取游戏...', ja: 'バイパスデータベースからゲームを取得中...', it: 'Recupero giochi dal database bypass...', pt: 'Obtendo jogos do banco de dados bypass...', ko: '우회 데이터베이스에서 게임 가져오는 중...', ar: 'جاري جلب الألعاب من قاعدة بيانات الالتفاف...', az: 'Bypass verilənlər bazasından oyunlar alınır...'
            },
            'search_by_name_or_appid': {
                tr: 'Oyun adı veya AppID ile arama yapın...', en: 'Search by game name or AppID...', de: 'Suche nach Spielname oder AppID...', fr: 'Rechercher par nom de jeu ou AppID...', es: 'Buscar por nombre de juego o AppID...', ru: 'Поиск по названию игры или AppID...', zh: '按游戏名称或AppID搜索...', ja: 'ゲーム名またはAppIDで検索...', it: 'Cerca per nome gioco o AppID...', pt: 'Pesquisar por nome do jogo ou AppID...', ko: '게임 이름 또는 AppID로 검색...', ar: 'البحث باسم اللعبة أو AppID...', az: 'Oyun adı və ya AppID ilə axtarış edin...'
            },
            'search': {
                tr: 'Ara', en: 'Search', de: 'Suchen', fr: 'Rechercher', es: 'Buscar', ru: 'Поиск', zh: '搜索', ja: '検索', it: 'Cerca', pt: 'Pesquisar', ko: '검색', ar: 'بحث', az: 'Axtar'
            },
            'clear_search': {
                tr: 'Aramayı Temizle', en: 'Clear Search', de: 'Suche löschen', fr: 'Effacer la recherche', es: 'Limpiar búsqueda', ru: 'Очистить поиск', zh: '清除搜索', ja: '検索をクリア', it: 'Cancella ricerca', pt: 'Limpar pesquisa', ko: '검색 지우기', ar: 'مسح البحث', az: 'Axtarışı təmizlə'
            },
            'no_bypass_search_results': {
                tr: 'Arama sonucu bulunamadı', en: 'No search results found', de: 'Keine Suchergebnisse gefunden', fr: 'Aucun résultat de recherche trouvé', es: 'No se encontraron resultados de búsqueda', ru: 'Результаты поиска не найдены', zh: '未找到搜索结果', ja: '検索結果が見つかりません', it: 'Nessun risultato di ricerca trovato', pt: 'Nenhum resultado de pesquisa encontrado', ko: '검색 결과를 찾을 수 없습니다', ar: 'لم يتم العثور على نتائج بحث', az: 'Axtarış nəticəsi tapılmadı'
            },
            'no_bypass_search_results_info': {
                tr: 'Arama kriterlerinize uygun bypass oyunu bulunamadı. Farklı anahtar kelimeler deneyin.', en: 'No bypass games found matching your search criteria. Try different keywords.', de: 'Keine Bypass-Spiele gefunden, die Ihren Suchkriterien entsprechen. Versuchen Sie andere Schlüsselwörter.', fr: 'Aucun jeu bypass trouvé correspondant à vos critères de recherche. Essayez différents mots-clés.', es: 'No se encontraron juegos bypass que coincidan con sus criterios de búsqueda. Pruebe diferentes palabras clave.', ru: 'Не найдено игр обхода, соответствующих вашим критериям поиска. Попробуйте другие ключевые слова.', zh: '未找到符合您搜索条件的绕过游戏。尝试不同的关键词。', ja: '検索条件に一致するバイパスゲームが見つかりませんでした。異なるキーワードを試してください。', it: 'Nessun gioco bypass trovato che corrisponda ai tuoi criteri di ricerca. Prova parole chiave diverse.', pt: 'Nenhum jogo bypass encontrado correspondendo aos seus critérios de pesquisa. Tente palavras-chave diferentes.', ko: '검색 조건에 맞는 우회 게임을 찾을 수 없습니다. 다른 키워드를 시도해 보세요.', ar: 'لم يتم العثور على ألعاب الالتفاف التي تطابق معايير البحث الخاصة بك. جرب كلمات مفتاحية مختلفة.', az: 'Axtarış kriterlərinizə uyğun bypass oyunu tapılmadı. Fərqli açar sözlər sınayın.'
            },
            'bypass_games_found': {
                tr: 'bypass oyunu bulundu', en: 'bypass games found', de: 'Bypass-Spiele gefunden', fr: 'jeux bypass trouvés', es: 'juegos bypass encontrados', ru: 'игр обхода найдено', zh: '找到绕过游戏', ja: 'バイパスゲームが見つかりました', it: 'giochi bypass trovati', pt: 'jogos bypass encontrados', ko: '우회 게임을 찾았습니다', ar: 'تم العثور على ألعاب الالتفاف', az: 'bypass oyunu tapıldı'
            },
            'library_icon': {
                tr: 'Kütüphane İkonu', en: 'Library Icon', de: 'Bibliothek-Symbol', fr: 'Icône de bibliothèque', es: 'Icono de biblioteca', ru: 'Иконка библиотеки', zh: '库图标', ja: 'ライブラリアイコン', it: 'Icona biblioteca', pt: 'Ícone da biblioteca', ko: '라이브러리 아이콘', ar: 'أيقونة المكتبة', az: 'Kitabxana İkonu'
            },
            'manual_install_icon': {
                tr: 'Manuel Kurulum İkonu', en: 'Manual Install Icon', de: 'Manueller Installations-Symbol', fr: 'Icône d\'installation manuelle', es: 'Icono de instalación manual', ru: 'Иконка ручной установки', zh: '手动安装图标', ja: '手動インストールアイコン', it: 'Icona installazione manuale', pt: 'Ícone de instalação manual', ko: '수동 설치 아이콘', ar: 'أيقونة التثبيت اليدوي', az: 'Manual Quraşdırma İkonu'
            },
            'settings_icon': {
                tr: 'Ayarlar İkonu', en: 'Settings Icon', de: 'Einstellungen-Symbol', fr: 'Icône des paramètres', es: 'Icono de configuración', ru: 'Иконка настроек', zh: '设置图标', ja: '設定アイコン', it: 'Icona impostazioni', pt: 'Ícone de configurações', ko: '설정 아이콘', ar: 'أيقونة الإعدادات', az: 'Parametrlər İkonu'
            },
            'background_1': {
                tr: 'Arkaplan 1', en: 'Background 1', de: 'Hintergrund 1', fr: 'Arrière-plan 1', es: 'Fondo 1', ru: 'Фон 1', zh: '背景 1', ja: '背景 1', it: 'Sfondo 1', pt: 'Fundo 1', ko: '배경 1', ar: 'الخلفية 1', az: 'Arxa Plan 1'
            },
            'background_2': {
                tr: 'Arkaplan 2', en: 'Background 2', de: 'Hintergrund 2', fr: 'Arrière-plan 2', es: 'Fondo 2', ru: 'Фон 2', zh: '背景 2', ja: '背景 2', it: 'Sfondo 2', pt: 'Fundo 2', ko: '배경 2', ar: 'الخلفية 2', az: 'Arxa Plan 2'
            },
            'background_3': {
                tr: 'Arkaplan 3', en: 'Background 3', de: 'Hintergrund 3', fr: 'Arrière-plan 3', es: 'Fondo 3', ru: 'Фон 3', zh: '背景 3', ja: '背景 3', it: 'Sfondo 3', pt: 'Fundo 3', ko: '배경 3', ar: 'الخلفية 3', az: 'Arxa Plan 3'
            },
            'accent_1': {
                tr: 'Vurgu 1', en: 'Accent 1', de: 'Akzent 1', fr: 'Accent 1', es: 'Acento 1', ru: 'Акцент 1', zh: '强调 1', ja: 'アクセント 1', it: 'Accento 1', pt: 'Destaque 1', ko: '강조 1', ar: 'تأكيد 1', az: 'Vurğu 1'
            },
            'accent_2': {
                tr: 'Vurgu 2', en: 'Accent 2', de: 'Akzent 2', fr: 'Accent 2', es: 'Acento 2', ru: 'Акцент 2', zh: '强调 2', ja: 'アクセント 2', it: 'Accento 2', pt: 'Destaque 2', ko: '강조 2', ar: 'تأكيد 2', az: 'Vurğu 2'
            },
            'text_1': {
                tr: 'Metin 1', en: 'Text 1', de: 'Text 1', fr: 'Texte 1', es: 'Texto 1', ru: 'Текст 1', zh: '文本 1', ja: 'テキスト 1', it: 'Testo 1', pt: 'Texto 1', ko: '텍스트 1', ar: 'النص 1', az: 'Mətn 1'
            },
            'text_2': {
                tr: 'Metin 2', en: 'Text 2', de: 'Text 2', fr: 'Texte 2', es: 'Texto 2', ru: 'Текст 2', zh: '文本 2', ja: 'テキスト 2', it: 'Testo 2', pt: 'Texto 2', ko: '텍스트 2', ar: 'النص 2', az: 'Mətn 2'
            },
            'border': {
                tr: 'Çizgi', en: 'Border', de: 'Rahmen', fr: 'Bordure', es: 'Borde', ru: 'Граница', zh: '边框', ja: '境界線', it: 'Bordo', pt: 'Borda', ko: '테두리', ar: 'الحدود', az: 'Sərhəd'
            },
            'accent': {
                tr: 'Vurgu', en: 'Accent', de: 'Akzent', fr: 'Accent', es: 'Acento', ru: 'Акцент', zh: '强调', ja: 'アクセント', it: 'Accento', pt: 'Destaque', ko: '강조', ar: 'تأكيد', az: 'Vurğu'
            },
            'background': {
                tr: 'Arkaplan', en: 'Background', de: 'Hintergrund', fr: 'Arrière-plan', es: 'Fondo', ru: 'Фон', zh: '背景', ja: '背景', it: 'Sfondo', pt: 'Fundo', ko: '배경', ar: 'الخلفية', az: 'Arxa Plan'
            },
            'top_bar': {
                tr: 'Üst Bar', en: 'Top Bar', de: 'Obere Leiste', fr: 'Barre supérieure', es: 'Barra superior', ru: 'Верхняя панель', zh: '顶部栏', ja: 'トップバー', it: 'Barra superiore', pt: 'Barra superior', ko: '상단 바', ar: 'الشريط العلوي', az: 'Yuxarı Bar'
            },
            'theme': {
                tr: 'Tema', en: 'Theme', de: 'Design', fr: 'Thème', es: 'Tema', ru: 'Тема', zh: '主题', ja: 'テーマ', it: 'Tema', pt: 'Tema', ko: '테마', ar: 'المظهر', az: 'Tema'
            },
            'quick_settings': {
                tr: 'Hızlı Ayarlar', en: 'Quick Settings', de: 'Schnelleinstellungen', fr: 'Paramètres rapides', es: 'Configuración rápida', ru: 'Быстрые настройки', zh: '快速设置', ja: 'クイック設定', it: 'Impostazioni rapide', pt: 'Configurações rápidas', ko: '빠른 설정', ar: 'الإعدادات السريعة', az: 'Sürətli Parametrlər'
            },
            'advanced': {
                tr: 'Gelişmiş', en: 'Advanced', de: 'Erweitert', fr: 'Avancé', es: 'Avanzado', ru: 'Расширенные', zh: '高级', ja: '詳細', it: 'Avanzato', pt: 'Avançado', ko: '고급', ar: 'متقدم', az: 'Təkmilləşdirilmiş'
            },
            'export': {
                tr: 'Dışa Aktar', en: 'Export', de: 'Exportieren', fr: 'Exporter', es: 'Exportar', ru: 'Экспорт', zh: '导出', ja: 'エクスポート', it: 'Esporta', pt: 'Exportar', ko: '내보내기', ar: 'تصدير', az: 'İxrac Et'
            },
            'import': {
                tr: 'İçe Aktar', en: 'Import', de: 'Importieren', fr: 'Importer', es: 'Importar', ru: 'Импорт', zh: '导入', ja: 'インポート', it: 'Importa', pt: 'Importar', ko: '가져오기', ar: 'استيراد', az: 'İdxal Et'
            },
            'customize_icons': {
                tr: 'İkonları Özelleştir', en: 'Customize Icons', de: 'Symbole anpassen', fr: 'Personnaliser les icônes', es: 'Personalizar iconos', ru: 'Настроить иконки', zh: '自定义图标', ja: 'アイコンをカスタマイズ', it: 'Personalizza icone', pt: 'Personalizar ícones', ko: '아이콘 사용자 정의', ar: 'تخصيص الأيقونات', az: 'İkonları Fərdiləşdir'
            },
            'advanced_editing': {
                tr: 'Gelişmiş Düzenleme', en: 'Advanced Editing', de: 'Erweiterte Bearbeitung', fr: 'Édition avancée', es: 'Edición avanzada', ru: 'Расширенное редактирование', zh: '高级编辑', ja: '詳細編集', it: 'Modifica avanzata', pt: 'Edição avançada', ko: '고급 편집', ar: 'تحرير متقدم', az: 'Təkmilləşdirilmiş Redaktə'
            },
            'card_hover': {
                tr: 'Kart Hover', en: 'Card Hover', de: 'Karten-Hover', fr: 'Survol de carte', es: 'Hover de tarjeta', ru: 'Наведение на карточку', zh: '卡片悬停', ja: 'カードホバー', it: 'Hover carta', pt: 'Hover do cartão', ko: '카드 호버', ar: 'تمرير البطاقة', az: 'Kart Hover'
            },
            'icons': {
                tr: 'İkonlar', en: 'Icons', de: 'Symbole', fr: 'Icônes', es: 'Iconos', ru: 'Иконки', zh: '图标', ja: 'アイコン', it: 'Icone', pt: 'Ícones', ko: '아이콘', ar: 'الأيقونات', az: 'İkonlar'
            },
            'theme_dark': {
                tr: 'Koyu', en: 'Dark', de: 'Dunkel', fr: 'Sombre', es: 'Oscuro', ru: 'Тёмная', zh: '深色', ja: 'ダーク', it: 'Scuro', pt: 'Escuro', ko: '다크', ar: 'داكن', az: 'Qaranlıq'
            },
            'theme_default': {
                tr: 'Varsayılan', en: 'Default', de: 'Standard', fr: 'Par défaut', es: 'Predeterminado', ru: 'По умолчанию', zh: '默认', ja: 'デフォルト', it: 'Predefinito', pt: 'Padrão', ko: '기본값', ar: 'افتراضي', az: 'Varsayılan'
            },
            'theme_aqua': {
                tr: 'Su', en: 'Aqua', de: 'Aqua', fr: 'Aqua', es: 'Aqua', ru: 'Аква', zh: '水色', ja: 'アクア', it: 'Acqua', pt: 'Aqua', ko: '아쿠아', ar: 'أكوا', az: 'Su'
            },
            'theme_sunset': {
                tr: 'Gün Batımı', en: 'Sunset', de: 'Sonnenuntergang', fr: 'Coucher de soleil', es: 'Atardecer', ru: 'Закат', zh: '日落', ja: 'サンセット', it: 'Tramonto', pt: 'Pôr do sol', ko: '선셋', ar: 'غروب الشمس', az: 'Gün Batımı'
            },
            'theme_neon': {
                tr: 'Neon', en: 'Neon', de: 'Neon', fr: 'Néon', es: 'Neón', ru: 'Неон', zh: '霓虹', ja: 'ネオン', it: 'Neon', pt: 'Neon', ko: '네온', ar: 'نيون', az: 'Neon'
            },
            'theme_light': {
                tr: 'Açık', en: 'Light', de: 'Hell', fr: 'Clair', es: 'Claro', ru: 'Светлая', zh: '浅色', ja: 'ライト', it: 'Chiaro', pt: 'Claro', ko: '라이트', ar: 'فاتح', az: 'Açıq'
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
            'discord_invite_title': {
                tr: 'Discord Sunucumuza Katıldınız mı?', en: 'Have you joined our Discord server?', de: 'Sind Sie unserem Discord-Server beigetreten?', fr: 'Avez-vous rejoint notre serveur Discord ?', es: '¿Te has unido a nuestro servidor de Discord?', ru: 'Вы присоединились к нашему серверу Discord?', zh: '您是否已加入我们的Discord服务器？', ja: 'Discordサーバーに参加しましたか？', it: 'Ti sei unito al nostro server Discord?', pt: 'Você se juntou ao nosso servidor Discord?', ko: 'Discord 서버에 참여하셨나요?', pl: 'Czy dołączyłeś do naszego serwera Discord?', az: 'Discord Serverimizə qoşuldunuzmu?'
            },
            'discord_invite_message': {
                tr: 'Güncellemeler, destek ve topluluk için Discord sunucumuza katılın.', en: 'Join our Discord server for updates, support and community.', de: 'Treten Sie unserem Discord-Server für Updates, Support und Community bei.', fr: 'Rejoignez notre serveur Discord pour les mises à jour, le support et la communauté.', es: 'Únete a nuestro servidor de Discord para actualizaciones, soporte y comunidad.', ru: 'Присоединяйтесь к нашему серверу Discord для обновлений, поддержки и сообщества.', zh: '加入我们的Discord服务器，获取更新、支持和社区交流。', ja: 'アップデート、サポート、コミュニティのためにDiscordサーバーに参加してください。', it: 'Unisciti al nostro server Discord per aggiornamenti, supporto e comunità.', pt: 'Junte-se ao nosso servidor Discord para atualizações, suporte e comunidade.', ko: '업데이트, 지원 및 커뮤니티를 위해 Discord 서버에 참여하세요.', pl: 'Dołącz do naszego serwera Discord, aby otrzymywać aktualizacje, wsparcie i być częścią społeczności.', az: 'Yeniləmələr, dəstək və icma üçün Discord serverimizə qoşulun.'
            },
            'discord_join_server': {
                tr: 'Sunucuya Katıl', en: 'Join Server', de: 'Server beitreten', fr: 'Rejoindre le serveur', es: 'Unirse al servidor', ru: 'Присоединиться к серверу', zh: '加入服务器', ja: 'サーバーに参加', it: 'Unisciti al server', pt: 'Entrar no servidor', ko: '서버 참여', pl: 'Dołącz do serwera', az: 'Serverə Qoşul'
            },
            'discord_later': {
                tr: 'Daha sonra', en: 'Later', de: 'Später', fr: 'Plus tard', es: 'Más tarde', ru: 'Позже', zh: '稍后', ja: '後で', it: 'Più tardi', pt: 'Mais tarde', ko: '나중에', pl: 'Później', az: 'Sonra'
            },
            'update_found_title': {
                tr: 'Yeni güncelleme bulundu', en: 'New update found', de: 'Neues Update gefunden', fr: 'Nouvelle mise à jour trouvée', es: 'Nueva actualización encontrada', ru: 'Найдено новое обновление', zh: '发现新更新', ja: '新しいアップデートが見つかりました', it: 'Nuovo aggiornamento trovato', pt: 'Nova atualização encontrada', ko: '새 업데이트 발견', pl: 'Znaleziono nową aktualizację', az: 'Yeni yeniləmə tapıldı'
            },
            'update_latest_version': {
                tr: 'En son sürüm', en: 'Latest version', de: 'Neueste Version', fr: 'Dernière version', es: 'Última versión', ru: 'Последняя версия', zh: '最新版本', ja: '最新バージョン', it: 'Ultima versione', pt: 'Versão mais recente', ko: '최신 버전', pl: 'Najnowsza wersja', az: 'Ən son versiya'
            },
            'update_current_version': {
                tr: 'Mevcut sürüm', en: 'Current version', de: 'Aktuelle Version', fr: 'Version actuelle', es: 'Versión actual', ru: 'Текущая версия', zh: '当前版本', ja: '現在のバージョン', it: 'Versione attuale', pt: 'Versão atual', ko: '현재 버전', pl: 'Aktualna wersja', az: 'Mövcud versiya'
            },
            'update_open_release': {
                tr: 'Güncellemeyi Aç', en: 'Open Update', de: 'Update öffnen', fr: 'Ouvrir la mise à jour', es: 'Abrir actualización', ru: 'Открыть обновление', zh: '打开更新', ja: 'アップデートを開く', it: 'Apri aggiornamento', pt: 'Abrir atualização', ko: '업데이트 열기', pl: 'Otwórz aktualizację', az: 'Yeniləməni Aç'
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
            'open_in_steam': {
                tr: "Steam'de Aç", en: 'Open in Steam', de: 'In Steam öffnen', fr: 'Ouvrir dans Steam', es: 'Abrir en Steam', ru: 'Открыть в Steam', zh: '在Steam中打开', ja: 'Steamで開く', it: 'Apri su Steam', pt: 'Abrir no Steam', ko: 'Steam에서 열기', pl: 'Otwórz w Steam', az: 'Steam-də Aç'
            },
            'loading_games': {
                tr: 'Yükleniyor...', en: 'Loading...', de: 'Lädt...', fr: 'Chargement...', es: 'Cargando...', ru: 'Загрузка...', zh: '加载中...', ja: '読み込み中...', it: 'Caricamento...', pt: 'Carregando...', ko: '로딩 중...', ar: 'جاري التحميل...', az: 'Yüklənir...'
            },
            'feature_coming_soon': {
                tr: 'Oyunu başlatma özelliği yakında eklenecek.', en: 'Game launch feature coming soon.', de: 'Spielstart-Funktion kommt bald.', fr: 'Fonction de lancement du jeu bientôt disponible.', es: 'La función de inicio de juego llegará pronto.', ru: 'Функция запуска игры скоро появится.', zh: '即将推出游戏启动功能。', ja: 'ゲーム起動機能は近日公開予定です。', it: 'La funzione di avvio del gioco arriverà presto.', pt: 'Recurso de iniciar juego em breve.', ko: '게임 실행 기능 곧 제공 예정.', pl: 'Funkcja uruchamiania gry już wkrótce.', az: 'Oyun başlatma xüsusiyyəti tezliklə əlavə ediləcək.' },
            'error': { tr: 'Hata', en: 'Error', de: 'Fehler', fr: 'Erreur', es: 'Error', ru: 'Ошибка', zh: '错误', ja: 'エラー', it: 'Errore', pt: 'Erro', ko: '오류', pl: 'Błąd', az: 'Xəta' },
            'success': { tr: 'Başarılı', en: 'Success', de: 'Erfolg', fr: 'Succès', es: 'Éxito', ru: 'Успешно', zh: '成功', ja: '成功', it: 'Successo', pt: 'Sucesso', ko: '성공', pl: 'Sukces', az: 'Uğurlu' },
            'info': { tr: 'Bilgi', en: 'Info', de: 'Info', fr: 'Info', es: 'Información', ru: 'Инфо', zh: '信息', ja: '情報', it: 'Info', pt: 'Informação', ko: '정보', pl: 'Informacja', az: 'Məlumat' },
            'game_not_found': { tr: 'Oyun bulunamadı', en: 'Game not found', de: 'Spiel nicht gefunden', fr: 'Jeu introuvable', es: 'Juego no encontrado', ru: 'Игра не найдена', zh: '未找到游戏', ja: 'ゲームが見つかりません', it: 'Gioco non trovato', pt: 'Jogo não encontrado', ko: '게임을 찾을 수 없음', pl: 'Nie znaleziono gry', az: 'Oyun tapılmadı' },
            'game_deleted': { tr: 'Oyun kütüphaneden silindi.', en: 'Game deleted from library.', de: 'Spiel aus Bibliothek gelöscht.', fr: 'Jeu supprimé de la bibliothèque.', es: 'Juego eliminado de la biblioteca.', ru: 'Игра удалена из библиотеки.', zh: '游戏已从库中删除。', ja: 'ライブラリからゲームが削除されました。', it: 'Gioco eliminato dalla libreria.', pt: 'Jogo removido da biblioteca.', ko: '라이브러리에서 게임이 삭제되었습니다.', pl: 'Gra została usunięta z biblioteki.', az: 'Oyun kitabxanadan silindi.' },
            'game_delete_failed': { tr: 'Oyun silinemedi.', en: 'Game could not be deleted.', de: 'Spiel konnte nicht gelöscht werden.', fr: 'Impossible de supprimer le jeu.', es: 'No se pudo eliminar el juego.', ru: 'Не удалось удалить игру.', zh: '无法删除游戏。', ja: 'ゲームを削除できませんでした。', it: 'Impossibile eliminare il gioco.', pt: 'Não foi possível remover o jogo.', ko: '게임을 삭제할 수 없습니다.', pl: 'Nie można usunąć gry.', az: 'Oyun silinə bilmədi.' },
            'feature_coming_soon': { tr: 'Oyunu başlatma özelliği yakında eklenecek.', en: 'Game launch feature coming soon.', de: 'Spielstart-Funktion kommt bald.', fr: 'Fonction de lancement du jeu bientôt disponible.', es: 'La función de inicio de juego llegará pronto.', ru: 'Функция запуска игры скоро появится.', zh: '即将推出游戏启动功能。', ja: 'ゲーム起動機能は近日公開予定です。', it: 'La funzione di avvio del gioco arriverà presto.', pt: 'Recurso de iniciar juego em breve.', ko: '게임 실행 기능 곧 제공 예정.', pl: 'Funkcja uruchamiania gry już wkrótce.', az: 'Oyun başlatma xüsusiyyəti tezliklə əlavə ediləcək.' },
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
                ar: 'فشل التحميل',
                az: 'Yükləmə uğursuz oldu'
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
            },
            'install_fix': {
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
            'uninstall_fix': {
                tr: 'Kaldır',
                en: 'Remove',
                de: 'Entfernen',
                fr: 'Supprimer',
                es: 'Eliminar',
                ru: 'Удалить',
                zh: '移除',
                ja: '削除',
                it: 'Rimuovi',
                pt: 'Remover',
                ko: '제거',
                pl: 'Usuń',
                az: 'Sil'
            },
            'repair_fix': {
                tr: 'Çevrimiçi Düzeltme',
                en: 'Online Fix',
                de: 'Online-Reparatur',
                fr: 'Correction en ligne',
                es: 'Corrección en línea',
                ru: 'Онлайн исправление',
                zh: '在线修复',
                ja: 'オンライン修正',
                it: 'Correzione online',
                pt: 'Correção online',
                ko: '온라인 수정',
                pl: 'Naprawa online',
                az: 'Onlayn Düzəliş'
            },
            'scanning_games': {
                tr: 'Oyunlar taranıyor...',
                en: 'Scanning games...',
                de: 'Spiele werden gescannt...',
                fr: 'Analyse des jeux...',
                es: 'Escaneando juegos...',
                ru: 'Сканирование игр...',
                zh: '扫描游戏中...',
                ja: 'ゲームをスキャン中...',
                it: 'Scansione giochi...',
                pt: 'Escaneando jogos...',
                ko: '게임 스캔 중...',
                pl: 'Skanowanie gier...',
                az: 'Oyunlar taranır...'
            },
            'installed': {
                tr: 'Kurulu',
                en: 'Installed',
                de: 'Installiert',
                fr: 'Installé',
                es: 'Instalado',
                ru: 'Установлено',
                zh: '已安装',
                ja: 'インストール済み',
                it: 'Installato',
                pt: 'Instalado',
                ko: '설치됨',
                pl: 'Zainstalowane',
                az: 'Quraşdırılıb'
            },
            'ready': {
                tr: 'Hazır',
                en: 'Ready',
                de: 'Bereit',
                fr: 'Prêt',
                es: 'Listo',
                ru: 'Готово',
                zh: '就绪',
                ja: '準備完了',
                it: 'Pronto',
                pt: 'Pronto',
                ko: '준비됨',
                pl: 'Gotowe',
                az: 'Hazır'
            },
            'select_file_to_download': {
                tr: 'İndirilecek dosyayı seçin',
                en: 'Select file to download',
                de: 'Datei zum Herunterladen auswählen',
                fr: 'Sélectionner le fichier à télécharger',
                es: 'Seleccionar archivo para descargar',
                ru: 'Выберите файл для скачивания',
                zh: '选择要下载的文件',
                ja: 'ダウンロードするファイルを選択',
                it: 'Seleziona file da scaricare',
                pt: 'Selecionar arquivo para baixar',
                ko: '다운로드할 파일 선택',
                pl: 'Wybierz plik do pobrania',
                az: 'Yüklənəcək faylı seçin'
            },
            'downloading': {
                tr: 'İndiriliyor...',
                en: 'Downloading...',
                de: 'Wird heruntergeladen...',
                fr: 'Téléchargement...',
                es: 'Descargando...',
                ru: 'Скачивание...',
                zh: '下载中...',
                ja: 'ダウンロード中...',
                it: 'Download in corso...',
                pt: 'Baixando...',
                ko: '다운로드 중...',
                pl: 'Pobieranie...',
                az: 'Yüklənir...'
            },
            'extracting': {
                tr: 'Çıkarılıyor...',
                en: 'Extracting...',
                de: 'Wird extrahiert...',
                fr: 'Extraction...',
                es: 'Extrayendo...',
                ru: 'Извлечение...',
                zh: '解压中...',
                ja: '展開中...',
                it: 'Estrazione...',
                pt: 'Extraindo...',
                ko: '압축 해제 중...',
                pl: 'Wypakowywanie...',
                az: 'Çıxarılır...'
            },
            'installation_complete': {
                tr: 'Kurulum tamamlandı',
                en: 'Installation complete',
                de: 'Installation abgeschlossen',
                fr: 'Installation terminée',
                es: 'Instalación completada',
                ru: 'Установка завершена',
                zh: '安装完成',
                ja: 'インストール完了',
                it: 'Installazione completata',
                pt: 'Instalação concluída',
                ko: '설치 완료',
                pl: 'Instalacja zakończona',
                az: 'Quraşdırma tamamlandı'
            },
            'uninstallation_complete': {
                tr: 'Kaldırma tamamlandı',
                en: 'Uninstallation complete',
                de: 'Deinstallation abgeschlossen',
                fr: 'Désinstallation terminée',
                es: 'Desinstalación completada',
                ru: 'Удаление завершено',
                zh: '卸载完成',
                ja: 'アンインストール完了',
                it: 'Disinstallazione completata',
                pt: 'Desinstalação concluída',
                ko: '제거 완료',
                pl: 'Odinstalowanie zakończone',
                az: 'Silinmə tamamlandı'
            },
            'no_files_found': {
                tr: 'Uygun dosya bulunamadı',
                en: 'No suitable files found',
                de: 'Keine passenden Dateien gefunden',
                fr: 'Aucun fichier approprié trouvé',
                es: 'No se encontraron archivos apropiados',
                ru: 'Подходящие файлы не найдены',
                zh: '未找到合适的文件',
                ja: '適切なファイルが見つかりません',
                it: 'Nessun file adatto trovato',
                pt: 'Nenhum arquivo adequado encontrado',
                ko: '적절한 파일을 찾을 수 없습니다',
                pl: 'Nie znaleziono odpowiednich plików',
                az: 'Uyğun fayl tapılmadı'
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
            'uninstallation_failed': {
                tr: 'Kaldırma başarısız',
                en: 'Uninstallation failed',
                de: 'Deinstallation fehlgeschlagen',
                fr: 'Échec de la désinstallation',
                es: 'Error en la desinstalación',
                ru: 'Ошибка удаления',
                zh: '卸载失败',
                ja: 'アンインストールに失敗しました',
                it: 'Disinstallazione fallita',
                pt: 'Falha na desinstalação',
                ko: '제거 실패',
                pl: 'Odinstalowanie nie powiodło się',
                az: 'Silinmə uğursuz oldu'
            },
            'uninstalling': {
                tr: 'Kaldırılıyor...',
                en: 'Uninstalling...',
                de: 'Wird deinstalliert...',
                fr: 'Désinstallation...',
                es: 'Desinstalando...',
                ru: 'Удаление...',
                zh: '卸载中...',
                ja: 'アンインストール中...',
                it: 'Disinstallazione...',
                pt: 'Desinstalando...',
                ko: '제거 중...',
                pl: 'Odinstalowywanie...',
                az: 'Silinir...'
            },
            'all_rights_reserved': {
                tr: 'Tüm hakları saklıdır.',
                en: 'All rights reserved.',
                de: 'Alle Rechte vorbehalten.',
                fr: 'Tous droits réservés.',
                es: 'Todos los derechos reservados.',
                ru: 'Все права защищены.',
                zh: '版权所有。',
                ja: '全著作権所有。',
                it: 'Tutti i diritti riservati.',
                pt: 'Todos os direitos reservados.',
                ko: '모든 권리 보유.',
                pl: 'Wszystkie prawa zastrzeżone.',
                az: 'Bütün hüquqlar qorunur.'
            },
            'launching_game': {
                tr: 'Oyun Steam üzerinden başlatılıyor...',
                en: 'Launching game through Steam...',
                de: 'Spiel wird über Steam gestartet...',
                fr: 'Lancement du jeu via Steam...',
                es: 'Iniciando juego a través de Steam...',
                ru: 'Запуск игры через Steam...',
                zh: '正在通过Steam启动游戏...',
                ja: 'Steam経由でゲームを起動中...',
                it: 'Avvio del gioco tramite Steam...',
                pt: 'Iniciando jogo através do Steam...',
                ko: 'Steam을 통해 게임 시작 중...',
                pl: 'Uruchamianie gry przez Steam...',
                az: 'Oyun Steam vasitəsilə başladılır...'
            },
            'games': {
                tr: 'Oyunlar',
                en: 'Games',
                de: 'Spiele',
                fr: 'Jeux',
                es: 'Juegos',
                ru: 'Игры',
                zh: '游戏',
                ja: 'ゲーム',
                it: 'Giochi',
                pt: 'Jogos',
                ko: '게임',
                pl: 'Gry',
                az: 'Oyunlar'
            },
            'popular_games': {
                tr: 'Popüler Oyunlar',
                en: 'Popular Games',
                de: 'Beliebte Spiele',
                fr: 'Jeux populaires',
                es: 'Juegos populares',
                ru: 'Популярные игры',
                zh: '热门游戏',
                ja: '人気ゲーム',
                it: 'Giochi popolari',
                pt: 'Jogos populares',
                ko: '인기 게임',
                pl: 'Popularne gry',
                az: 'Məşhur Oyunlar'
            },
            'new_games': {
                tr: 'Yeni Çıkan Oyunlar',
                en: 'New Games',
                de: 'Neue Spiele',
                fr: 'Nouveaux jeux',
                es: 'Juegos nuevos',
                ru: 'Новые игры',
                zh: '新游戏',
                ja: '新作ゲーム',
                it: 'Nuovi giochi',
                pt: 'Jogos novos',
                ko: '새 게임',
                pl: 'Nowe gry',
                az: 'Yeni Oyunlar'
            },
            'top_games': {
                tr: 'En İyi Oyunlar',
                en: 'Top Games',
                de: 'Top-Spiele',
                fr: 'Meilleurs jeux',
                es: 'Mejores juegos',
                ru: 'Лучшие игры',
                zh: '顶级游戏',
                ja: 'トップゲーム',
                it: 'Migliori giochi',
                pt: 'Melhores jogos',
                ko: '최고 게임',
                pl: 'Najlepsze gry',
                az: 'Ən Yaxşı Oyunlar'
            },
            'free_games': {
                tr: 'Ücretsiz Oyunlar',
                en: 'Free Games',
                de: 'Kostenlose Spiele',
                fr: 'Jeux gratuits',
                es: 'Juegos gratis',
                ru: 'Бесплатные игры',
                zh: '免费游戏',
                ja: '無料ゲーム',
                it: 'Giochi gratuiti',
                pt: 'Jogos grátis',
                ko: '무료 게임',
                pl: 'Darmowe gry',
                az: 'Pulsuz Oyunlar'
            },
            'action_games': {
                tr: 'Aksiyon Oyunları',
                en: 'Action Games',
                de: 'Actionspiele',
                fr: 'Jeux d\'action',
                es: 'Juegos de acción',
                ru: 'Экшен игры',
                zh: '动作游戏',
                ja: 'アクションゲーム',
                it: 'Giochi d\'azione',
                pt: 'Jogos de ação',
                ko: '액션 게임',
                pl: 'Gry akcji',
                az: 'Aksiya Oyunları'
            },
            'rpg_games': {
                tr: 'RPG Oyunları',
                en: 'RPG Games',
                de: 'RPG-Spiele',
                fr: 'Jeux RPG',
                es: 'Juegos RPG',
                ru: 'RPG игры',
                zh: 'RPG游戏',
                ja: 'RPGゲーム',
                it: 'Giochi RPG',
                pt: 'Jogos RPG',
                ko: 'RPG 게임',
                pl: 'Gry RPG',
                az: 'RPG Oyunları'
            },
            'strategy_games': {
                tr: 'Strateji Oyunları',
                en: 'Strategy Games',
                de: 'Strategiespiele',
                fr: 'Jeux de stratégie',
                es: 'Juegos de estrategia',
                ru: 'Стратегии',
                zh: '策略游戏',
                ja: 'ストラテジーゲーム',
                it: 'Giochi di strategia',
                pt: 'Jogos de estratégia',
                ko: '전략 게임',
                pl: 'Gry strategiczne',
                az: 'Strategiya Oyunları'
            },
            'steam_search_no_results': {
                tr: 'Steam arama sonuçları bulunamadı',
                en: 'Steam search results not found',
                de: 'Steam-Suchergebnisse nicht gefunden',
                fr: 'Résultats de recherche Steam introuvables',
                es: 'No se encontraron resultados de búsqueda de Steam',
                ru: 'Результаты поиска Steam не найдены',
                zh: '未找到Steam搜索结果',
                ja: 'Steam検索結果が見つかりません',
                it: 'Risultati di ricerca Steam non trovati',
                pt: 'Resultados da pesquisa Steam não encontrados',
                ko: 'Steam 검색 결과를 찾을 수 없습니다',
                pl: 'Nie znaleziono wyników wyszukiwania Steam',
                az: 'Steam axtarış nəticələri tapılmadı'
            },
            'games_found': {
                tr: 'oyun bulundu',
                en: 'games found',
                de: 'Spiele gefunden',
                fr: 'jeux trouvés',
                es: 'juegos encontrados',
                ru: 'игр найдено',
                zh: '游戏已找到',
                ja: 'ゲームが見つかりました',
                it: 'giochi trovati',
                pt: 'jogos encontrados',
                ko: '게임 발견됨',
                pl: 'gier znaleziono',
                az: 'oyun tapıldı'
            },
            'games_found_in_library': {
                tr: 'oyun bulundu',
                en: 'games found',
                de: 'Spiele gefunden',
                fr: 'jeux trouvés',
                es: 'juegos encontrados',
                ru: 'игр найдено',
                zh: '游戏已找到',
                ja: 'ゲームが見つかりました',
                it: 'giochi trovati',
                pt: 'jogos encontrados',
                ko: '게임 발견됨',
                pl: 'gier znaleziono',
                az: 'oyun tapıldı'
            },
            'getting_details': {
                tr: 'detaylar alınıyor',
                en: 'getting details',
                de: 'Details werden abgerufen',
                fr: 'récupération des détails',
                es: 'obteniendo detalles',
                ru: 'получение деталей',
                zh: '获取详情',
                ja: '詳細を取得中',
                it: 'recupero dettagli',
                pt: 'obtendo detalhes',
                ko: '세부 정보 가져오는 중',
                pl: 'pobieranie szczegółów',
                az: 'təfərrüatlar alınır'
            },
            'getting_game_details': {
                tr: 'Oyun',
                en: 'Game',
                de: 'Spiel',
                fr: 'Jeu',
                es: 'Juego',
                ru: 'Игра',
                zh: '游戏',
                ja: 'ゲーム',
                it: 'Gioco',
                pt: 'Jogo',
                ko: '게임',
                pl: 'Gra',
                az: 'Oyun'
            },
            'game_data_not_found': {
                tr: 'Oyun verisi bulunamadı',
                en: 'Game data not found',
                de: 'Spieldaten nicht gefunden',
                fr: 'Données du jeu introuvables',
                es: 'Datos del juego no encontrados',
                ru: 'Данные игры не найдены',
                zh: '未找到游戏数据',
                ja: 'ゲームデータが見つかりません',
                it: 'Dati del gioco non trovati',
                pt: 'Dados do jogo não encontrados',
                ko: '게임 데이터를 찾을 수 없습니다',
                pl: 'Nie znaleziono danych gry',
                az: 'Oyun məlumatları tapılmadı'
            },
            'game_successfully_loaded': {
                tr: 'Oyun başarıyla yüklendi',
                en: 'Game successfully loaded',
                de: 'Spiel erfolgreich geladen',
                fr: 'Jeu chargé avec succès',
                es: 'Juego cargado exitosamente',
                ru: 'Игра успешно загружена',
                zh: '游戏成功加载',
                ja: 'ゲームが正常に読み込まれました',
                it: 'Gioco caricato con successo',
                pt: 'Jogo carregado com sucesso',
                ko: '게임이 성공적으로 로드되었습니다',
                pl: 'Gra została pomyślnie załadowana',
                az: 'Oyun uğurla yükləndi'
            },
            'go_back': {
                tr: 'Geri Dön',
                en: 'Go Back',
                de: 'Zurück',
                fr: 'Retour',
                es: 'Volver',
                ru: 'Назад',
                zh: '返回',
                ja: '戻る',
                it: 'Indietro',
                pt: 'Voltar',
                ko: '뒤로',
                pl: 'Wróć',
                az: 'Geri Dön'
            },
            'an_error_occurred': {
                tr: 'Bir hata oluştu',
                en: 'An error occurred',
                de: 'Ein Fehler ist aufgetreten',
                fr: 'Une erreur s\'est produite',
                es: 'Ocurrió un error',
                ru: 'Произошла ошибка',
                zh: '发生错误',
                ja: 'エラーが発生しました',
                it: 'Si è verificato un errore',
                pt: 'Ocorreu um erro',
                ko: '오류가 발생했습니다',
                pl: 'Wystąpił błąd',
                az: 'Xəta baş verdi'
            },
            'getting_steam_search_results': {
                tr: 'Steam arama sonuçları alınıyor...',
                en: 'Getting Steam search results...',
                de: 'Steam-Suchergebnisse werden abgerufen...',
                fr: 'Récupération des résultats de recherche Steam...',
                es: 'Obteniendo resultados de búsqueda de Steam...',
                ru: 'Получение результатов поиска Steam...',
                zh: '正在获取Steam搜索结果...',
                ja: 'Steam検索結果を取得中...',
                it: 'Recupero risultati di ricerca Steam...',
                pt: 'Obtendo resultados da pesquisa Steam...',
                ko: 'Steam 검색 결과 가져오는 중...',
                pl: 'Pobieranie wyników wyszukiwania Steam...',
                az: 'Steam axtarış nəticələri alınır...'
            },
            'error_loading_game': {
                tr: 'Oyun yüklenirken hata',
                en: 'Error loading game',
                de: 'Fehler beim Laden des Spiels',
                fr: 'Erreur lors du chargement du jeu',
                es: 'Error al cargar el juego',
                ru: 'Ошибка загрузки игры',
                zh: '加载游戏时出错',
                ja: 'ゲーム読み込みエラー',
                it: 'Errore nel caricamento del gioco',
                pt: 'Erro ao carregar o jogo',
                ko: '게임 로드 오류',
                pl: 'Błąd podczas ładowania gry',
                az: 'Oyun yüklənərkən xəta'
            },
            'game_info_load_failed': {
                tr: 'Oyun bilgileri yüklenemedi',
                en: 'Game information could not be loaded',
                de: 'Spielinformationen konnten nicht geladen werden',
                fr: 'Impossible de charger les informations du jeu',
                es: 'No se pudieron cargar las información del juego',
                ru: 'Не удалось загрузить информацию об игре',
                zh: '无法加载游戏信息',
                ja: 'ゲーム情報を読み込めませんでした',
                it: 'Impossibile caricare le informazioni del gioco',
                pt: 'Não foi possível carregar as informações do jogo',
                ko: '게임 정보를 로드할 수 없습니다',
                pl: 'Nie można załadować informacji o grze',
                az: 'Oyun məlumatları yüklənə bilmədi'
            },
            'games_successfully_loaded': {
                tr: 'oyun başarıyla yüklendi',
                en: 'games successfully loaded',
                de: 'Spiele erfolgreich geladen',
                fr: 'jeux chargés avec succès',
                es: 'juegos cargados exitosamente',
                ru: 'игр успешно загружено',
                zh: '游戏成功加载',
                ja: 'ゲームが正常に読み込まれました',
                it: 'giochi caricati con successo',
                pt: 'jogos carregados com sucesso',
                ko: '게임이 성공적으로 로드되었습니다',
                pl: 'gier pomyślnie załadowano',
                az: 'oyun uğurla yükləndi'
            },
            'no_games_loaded': {
                tr: 'Hiç oyun yüklenemedi',
                en: 'No games could be loaded',
                de: 'Keine Spiele konnten geladen werden',
                fr: 'Aucun jeu n\'a pu être chargé',
                es: 'No se pudieron cargar juegos',
                ru: 'Не удалось загрузить игры',
                zh: '无法加载游戏',
                ja: 'ゲームを読み込めませんでした',
                it: 'Nessun gioco è stato caricato',
                pt: 'Nenhum jogo pôde ser carregado',
                ko: '게임을 로드할 수 없습니다',
                pl: 'Nie można załadować gier',
                az: 'Heç bir oyun yüklənə bilmədi'
            },
            'steam_search_error': {
                tr: 'Steam arama hatası',
                en: 'Steam search error',
                de: 'Steam-Suchfehler',
                fr: 'Erreur de recherche Steam',
                es: 'Error de búsqueda de Steam',
                ru: 'Ошибка поиска Steam',
                zh: 'Steam搜索错误',
                ja: 'Steam検索エラー',
                it: 'Errore di ricerca Steam',
                pt: 'Erro na pesquisa Steam',
                ko: 'Steam 검색 오류',
                pl: 'Błąd wyszukiwania Steam',
                az: 'Steam axtarış xətası'
            },
            'steam_search_results_failed': {
                tr: 'Steam arama sonuçları alınamadı',
                en: 'Steam search results could not be retrieved',
                de: 'Steam-Suchergebnisse konnten nicht abgerufen werden',
                fr: 'Impossible de récupérer les résultats de recherche Steam',
                es: 'No se pudieron obtener los resultados de búsqueda de Steam',
                ru: 'Не удалось получить результаты поиска Steam',
                zh: '无法获取Steam搜索结果',
                ja: 'Steam検索結果を取得できませんでした',
                it: 'Impossibile recuperare i risultati di ricerca Steam',
                pt: 'Não foi possível obter os resultados da pesquisa Steam',
                ko: 'Steam 검색 결과를 가져올 수 없습니다',
                pl: 'Nie można było pobrać wyników wyszukiwania Steam',
                az: 'Steam axtarış nəticələri alına bilmədi'
            },
            'general_error_loading_games': {
                tr: 'Tüm oyunlar yüklenirken genel hata',
                en: 'General error while loading all games',
                de: 'Allgemeiner Fehler beim Laden aller Spiele',
                fr: 'Erreur générale lors du chargement de tous les jeux',
                es: 'Error general al cargar todos los juegos',
                ru: 'Общая ошибка при загрузке всех игр',
                zh: '加载所有游戏时出现一般错误',
                ja: 'すべてのゲームを読み込む際の一般的なエラー',
                it: 'Errore generale durante il caricamento di tutti i giochi',
                pt: 'Erro geral ao carregar todos os jogos',
                ko: '모든 게임을 로드하는 중 일반 오류',
                pl: 'Ogólny błąd podczas ładowania wszystkich gier',
                az: 'Bütün oyunları yükləyərkən ümumi xəta'
            },
            'searching_games': {
                tr: 'Oyunlar aranıyor...',
                en: 'Searching games...',
                de: 'Spiele werden gesucht...',
                fr: 'Recherche de jeux...',
                es: 'Buscando juegos...',
                ru: 'Поиск игр...',
                zh: '搜索游戏中...',
                ja: 'ゲームを検索中...',
                it: 'Ricerca giochi...',
                pt: 'Procurando jogos...',
                ko: '게임 검색 중...',
                pl: 'Wyszukiwanie gier...',
                az: 'Oyunlar axtarılır...'
            },
            'searching_for': {
                tr: 'Aranıyor',
                en: 'Searching for',
                de: 'Suche nach',
                fr: 'Recherche de',
                es: 'Buscando',
                ru: 'Поиск',
                zh: '搜索',
                ja: '検索中',
                it: 'Ricerca di',
                pt: 'Procurando por',
                ko: '검색 중',
                pl: 'Wyszukiwanie',
                az: 'Axtarılır'
            },
            'game_not_found': {
                tr: 'Oyun bulunamadı',
                en: 'Game not found',
                de: 'Spiel nicht gefunden',
                fr: 'Jeu introuvable',
                es: 'Juego no encontrado',
                ru: 'Игра не найдена',
                zh: '未找到游戏',
                ja: 'ゲームが見つかりません',
                it: 'Gioco non trovato',
                pt: 'Jogo não encontrado',
                ko: '게임을 찾을 수 없습니다',
                pl: 'Gra nie została znaleziona',
                az: 'Oyun tapılmadı'
            },
            'appid_search_failed': {
                tr: 'AppID ile arama başarısız',
                en: 'AppID search failed',
                de: 'AppID-Suche fehlgeschlagen',
                fr: 'Échec de la recherche par AppID',
                es: 'Búsqueda por AppID fallida',
                ru: 'Поиск по AppID не удался',
                zh: 'AppID搜索失败',
                ja: 'AppID検索に失敗しました',
                it: 'Ricerca per AppID fallita',
                pt: 'Falha na pesquisa por AppID',
                ko: 'AppID 검색 실패',
                pl: 'Wyszukiwanie po AppID nie powiodło się',
                az: 'AppID ilə axtarış uğursuz oldu'
            },
            'dlc_not_supported': {
                tr: 'DLC desteklenmiyor',
                en: 'DLC not supported',
                de: 'DLC wird nicht unterstützt',
                fr: 'DLC non pris en charge',
                es: 'DLC no soportado',
                ru: 'DLC не поддерживается',
                zh: '不支持DLC',
                ja: 'DLCはサポートされていません',
                it: 'DLC non supportato',
                pt: 'DLC não suportado',
                ko: 'DLC가 지원되지 않습니다',
                pl: 'DLC nie jest obsługiwane',
                az: 'DLC dəstəklənmir'
            },
            'name_search_failed': {
                tr: 'İsim ile arama başarısız',
                en: 'Name search failed',
                de: 'Namenssuche fehlgeschlagen',
                fr: 'Échec de la recherche par nom',
                es: 'Búsqueda por nombre fallida',
                ru: 'Поиск по имени не удался',
                zh: '名称搜索失败',
                ja: '名前検索に失敗しました',
                it: 'Ricerca per nome fallita',
                pt: 'Falha na pesquisa por nome',
                ko: '이름 검색 실패',
                pl: 'Wyszukiwanie po nazwie nie powiodło się',
                az: 'Ad ilə axtarış uğursuz oldu'
            },
            'search_results_for': {
                tr: 'Arama sonuçları',
                en: 'Search results for',
                de: 'Suchergebnisse für',
                fr: 'Résultats de recherche pour',
                es: 'Resultados de búsqueda para',
                ru: 'Результаты поиска для',
                zh: '搜索结果',
                ja: '検索結果',
                it: 'Risultati di ricerca per',
                pt: 'Resultados da pesquisa para',
                ko: '검색 결과',
                pl: 'Wyniki wyszukiwania dla',
                az: 'Axtarış nəticələri'
            },
            'no_games_found': {
                tr: 'Oyun bulunamadı',
                en: 'No games found',
                de: 'Keine Spiele gefunden',
                fr: 'Aucun jeu trouvé',
                es: 'No se encontraron juegos',
                ru: 'Игры не найдены',
                zh: '未找到游戏',
                ja: 'ゲームが見つかりません',
                it: 'Nessun gioco trovato',
                pt: 'Nenhum jogo encontrado',
                ko: '게임을 찾을 수 없습니다',
                pl: 'Nie znaleziono gier',
                az: 'Oyun tapılmadı'
            },
            'no_games_found_for': {
                tr: 'Aranan terim için oyun bulunamadı',
                en: 'No games found for',
                de: 'Keine Spiele gefunden für',
                fr: 'Aucun jeu trouvé pour',
                es: 'No se encontraron juegos para',
                ru: 'Игры не найдены для',
                zh: '未找到游戏',
                ja: 'ゲームが見つかりません',
                it: 'Nessun gioco trovato per',
                pt: 'Nenhum jogo encontrado para',
                ko: '게임을 찾을 수 없습니다',
                pl: 'Nie znaleziono gier dla',
                az: 'Axtarışınız üçün oyun tapılmadı'
            },
            'search_suggestions': {
                tr: 'Arama önerileri',
                en: 'Search suggestions',
                de: 'Suchvorschläge',
                fr: 'Suggestions de recherche',
                es: 'Sugerencias de búsqueda',
                ru: 'Советы по поиску',
                zh: '搜索建议',
                ja: '検索のヒント',
                it: 'Suggerimenti di ricerca',
                pt: 'Sugestões de pesquisa',
                ko: '검색 제안',
                pl: 'Sugestie wyszukiwania',
                az: 'Axtarış təklifləri'
            },
            'check_spelling': {
                tr: 'Yazımı kontrol edin',
                en: 'Check spelling',
                de: 'Rechtschreibung prüfen',
                fr: 'Vérifiez l\'orthographe',
                es: 'Verifica la ortografía',
                ru: 'Проверьте правописание',
                zh: '检查拼写',
                ja: 'スペルを確認してください',
                it: 'Controlla l\'ortografia',
                pt: 'Verifique a ortografia',
                ko: '철자 확인',
                pl: 'Sprawdź pisownię',
                az: 'Yazımı yoxlayın'
            },
            'try_different_keywords': {
                tr: 'Farklı anahtar kelimeler deneyin',
                en: 'Try different keywords',
                de: 'Verschiedene Schlüsselwörter versuchen',
                fr: 'Essayez des mots-clés différents',
                es: 'Prueba palabras clave diferentes',
                ru: 'Попробуйте другие ключевые слова',
                zh: '尝试不同的关键词',
                ja: '異なるキーワードを試してください',
                it: 'Prova parole chiave diverse',
                pt: 'Tente palavras-chave diferentes',
                ko: '다른 키워드를 시도해보세요',
                pl: 'Spróbuj różnych słów kluczowych',
                az: 'Fərqli açar sözlər sınayın'
            },
            'use_steam_app_id': {
                tr: 'Steam App ID kullanın',
                en: 'Use Steam App ID',
                de: 'Steam App ID verwenden',
                fr: 'Utilisez l\'ID de l\'application Steam',
                es: 'Usa el ID de la aplicación Steam',
                ru: 'Используйте Steam App ID',
                zh: '使用Steam应用ID',
                ja: 'SteamアプリIDを使用してください',
                it: 'Usa l\'ID dell\'app Steam',
                pt: 'Use o ID do aplicativo Steam',
                ko: 'Steam 앱 ID를 사용하세요',
                pl: 'Użyj Steam App ID',
                az: 'Steam App ID istifadə edin'
            },
            'search_error': {
                tr: 'Arama hatası',
                en: 'Search error',
                de: 'Suchfehler',
                fr: 'Erreur de recherche',
                es: 'Error de búsqueda',
                ru: 'Ошибка поиска',
                zh: '搜索错误',
                ja: '検索エラー',
                it: 'Errore di ricerca',
                pt: 'Erro na pesquisa',
                ko: '검색 오류',
                pl: 'Błąd wyszukiwania',
                az: 'Axtarış xətası'
            },
            'unknown_search_error': {
                tr: 'Bilinmeyen arama hatası',
                en: 'Unknown search error',
                de: 'Unbekannter Suchfehler',
                fr: 'Erreur de recherche inconnue',
                es: 'Error de búsqueda desconocido',
                ru: 'Неизвестная ошибка поиска',
                zh: '未知搜索错误',
                ja: '不明な検索エラー',
                it: 'Errore di ricerca sconosciuto',
                pt: 'Erro de pesquisa desconhecido',
                ko: '알 수 없는 검색 오류',
                pl: 'Nieznany błąd wyszukiwania',
                az: 'Naməlum axtarış xətası'
            },
            'retry_search': {
                tr: 'Aramayı yeniden dene',
                en: 'Retry search',
                de: 'Suche wiederholen',
                fr: 'Réessayer la recherche',
                es: 'Reintentar búsqueda',
                ru: 'Повторить поиск',
                zh: '重试搜索',
                ja: '検索を再試行',
                it: 'Riprova ricerca',
                pt: 'Tentar pesquisa novamente',
                ko: '검색 재시도',
                pl: 'Ponów wyszukiwanie',
                az: 'Axtarışı yenidən sınayın'
            },
            'warning': {
                tr: 'Uyarı',
                en: 'Warning',
                de: 'Warnung',
                fr: 'Avertissement',
                es: 'Advertencia',
                ru: 'Предупреждение',
                zh: '警告',
                ja: '警告',
                it: 'Avviso',
                pt: 'Aviso',
                ko: '경고',
                pl: 'Ostrzeżenie',
                az: 'Xəbərdarlıq'
            },
            'some_game_info_load_failed': {
                tr: 'Bazı oyun bilgileri yüklenemedi. Temel bilgiler gösteriliyor.',
                en: 'Some game information could not be loaded. Showing basic information.',
                de: 'Einige Spielinformationen konnten nicht geladen werden. Grundlegende Informationen werden angezeigt.',
                fr: 'Certaines informations du jeu n\'ont pas pu être chargées. Affichage des informations de base.',
                es: 'Algunos datos del juego no se pudieron cargar. Mostrando información básica.',
                ru: 'Некоторые данные об игре не удалось загрузить. Показывается базовая информация.',
                zh: '某些游戏信息无法加载。显示基本信息。',
                ja: '一部のゲーム情報を読み込めませんでした。基本情報を表示しています。',
                it: 'Alcune informazioni del gioco non sono state caricate. Mostrando informazioni di base.',
                pt: 'Algumas informações do jogo não puderam ser carregadas. Mostrando informações básicas.',
                ko: '일부 게임 정보를 로드할 수 없습니다. 기본 정보를 표시합니다.',
                pl: 'Nie można załadować niektórych informacji o grze. Wyświetlanie podstawowych informacji.',
                az: 'Bəzi oyun məlumatları yüklənə bilmədi. Əsas məlumatlar göstərilir.'
            },
            'loading_game': {
                tr: 'Oyun yükleniyor',
                en: 'Loading game',
                de: 'Spiel wird geladen',
                fr: 'Chargement du jeu',
                es: 'Cargando juego',
                ru: 'Загрузка игры',
                zh: '加载游戏',
                ja: 'ゲームを読み込み中',
                it: 'Caricamento gioco',
                pt: 'Carregando jogo',
                ko: '게임 로드 중',
                pl: 'Ładowanie gry',
                az: 'Oyun yüklənir'
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
                en: 'Türkçe',
                de: 'Türkçe',
                fr: 'Türkçe',
                es: 'Türkçe',
                ru: 'Türkçe',
                zh: 'Türkçe',
                ja: 'Türkçe',
                it: 'Türkçe',
                pt: 'Türkçe',
                ko: 'Türkçe',
                pl: 'Türkçe',
                ar: 'Türkçe',
                az: 'Türkçe'
            },
            'lang_en': {
                tr: 'English',
                en: 'English',
                de: 'English',
                fr: 'English',
                es: 'English',
                ru: 'English',
                zh: 'English',
                ja: 'English',
                it: 'English',
                pt: 'English',
                ko: 'English',
                pl: 'English',
                ar: 'English',
                az: 'English'
            },
            'lang_de': {
                tr: 'Deutsch',
                en: 'Deutsch',
                de: 'Deutsch',
                fr: 'Deutsch',
                es: 'Deutsch',
                ru: 'Deutsch',
                zh: 'Deutsch',
                ja: 'Deutsch',
                it: 'Deutsch',
                pt: 'Deutsch',
                ko: 'Deutsch',
                pl: 'Deutsch',
                ar: 'Deutsch',
                az: 'Deutsch'
            },
            'lang_fr': {
                tr: 'Français',
                en: 'Français',
                de: 'Français',
                fr: 'Français',
                es: 'Français',
                ru: 'Français',
                zh: 'Français',
                ja: 'Français',
                it: 'Français',
                pt: 'Français',
                ko: 'Français',
                pl: 'Français',
                ar: 'Français',
                az: 'Français'
            },
            'lang_es': {
                tr: 'Español',
                en: 'Español',
                de: 'Español',
                fr: 'Español',
                es: 'Español',
                ru: 'Español',
                zh: 'Español',
                ja: 'Español',
                it: 'Español',
                pt: 'Español',
                ko: 'Español',
                pl: 'Español',
                ar: 'Español',
                az: 'Español'
            },
            'lang_ru': {
                tr: 'Русский',
                en: 'Русский',
                de: 'Русский',
                fr: 'Русский',
                es: 'Русский',
                ru: 'Русский',
                zh: 'Русский',
                ja: 'Русский',
                it: 'Русский',
                pt: 'Русский',
                ko: 'Русский',
                pl: 'Русский',
                ar: 'Русский',
                az: 'Русский'
            },
            'lang_zh': {
                tr: '中文',
                en: '中文',
                de: '中文',
                fr: '中文',
                es: '中文',
                ru: '中文',
                zh: '中文',
                ja: '中文',
                it: '中文',
                pt: '中文',
                ko: '中文',
                pl: '中文',
                ar: '中文',
                az: '中文'
            },
            'lang_ja': {
                tr: '日本語',
                en: '日本語',
                de: '日本語',
                fr: '日本語',
                es: '日本語',
                ru: '日本語',
                zh: '日本語',
                ja: '日本語',
                it: '日本語',
                pt: '日本語',
                ko: '日本語',
                pl: '日本語',
                ar: '日本語',
                az: '日本語'
            },
            'lang_it': {
                tr: 'Italiano',
                en: 'Italiano',
                de: 'Italiano',
                fr: 'Italiano',
                es: 'Italiano',
                ru: 'Italiano',
                zh: 'Italiano',
                ja: 'Italiano',
                it: 'Italiano',
                pt: 'Italiano',
                ko: 'Italiano',
                pl: 'Italiano',
                ar: 'Italiano',
                az: 'Italiano'
            },
            'lang_pt': {
                tr: 'Português',
                en: 'Português',
                de: 'Português',
                fr: 'Português',
                es: 'Português',
                ru: 'Português',
                zh: 'Português',
                ja: 'Português',
                it: 'Português',
                pt: 'Português',
                ko: 'Português',
                pl: 'Português',
                ar: 'Português',
                az: 'Português'
            },
            'lang_pl': {
                tr: 'Polski',
                en: 'Polski',
                de: 'Polski',
                fr: 'Polski',
                es: 'Polski',
                ru: 'Polski',
                zh: 'Polski',
                ja: 'Polski',
                it: 'Polski',
                pt: 'Polski',
                ko: 'Polski',
                pl: 'Polski',
                ar: 'Polski',
                az: 'Polski'
            },
            'lang_ar': {
                tr: 'العربية',
                en: 'العربية',
                de: 'العربية',
                fr: 'العربية',
                es: 'العربية',
                ru: 'العربية',
                zh: 'العربية',
                ja: 'العربية',
                it: 'العربية',
                pt: 'العربية',
                ko: 'العربية',
                pl: 'العربية',
                ar: 'العربية',
                az: 'العربية'
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
            'lang_az': {
                tr: 'Azərbaycan dili',
                en: 'Azərbaycan dili',
                de: 'Azərbaycan dili',
                fr: 'Azərbaycan dili',
                es: 'Azərbaycan dili',
                ru: 'Azərbaycan dili',
                zh: 'Azərbaycan dili',
                ja: 'Azərbaycan dili',
                it: 'Azərbaycan dili',
                pt: 'Azərbaycan dili',
                ko: 'Azərbaycan dili',
                pl: 'Azərbaycan dili',
                ar: 'Azərbaycan dili',
                az: 'Azərbaycan dili'
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
            },
            
            'loading_screen': {
                tr: 'Yükleme Ekranı', en: 'Loading Screen', de: 'Ladebildschirm', fr: 'Écran de chargement', es: 'Pantalla de carga', ru: 'Экран загрузки', zh: '加载屏幕', ja: 'ローディング画面', it: 'Schermata di caricamento', pt: 'Tela de carregamento', ko: '로딩 화면', ar: 'شاشة التحميل', az: 'Yükləmə ekranı'
            },
            'loading_customization': {
                tr: 'Yükleme ekranı özelleştirme', en: 'Loading screen customization', de: 'Ladebildschirm-Anpassung', fr: 'Personnalisation de l\'écran de chargement', es: 'Personalización de pantalla de carga', ru: 'Настройка экрана загрузки', zh: '加载屏幕自定义', ja: 'ローディング画面のカスタマイズ', it: 'Personalizzazione schermata di caricamento', pt: 'Personalização da tela de carregamento', ko: '로딩 화면 사용자 정의', ar: 'تخصيص شاشة التحميل', az: 'Yükləmə ekranının fərdiləşdirilməsi'
            },
            'spinner_color': {
                tr: 'Spinner Rengi', en: 'Spinner Color', de: 'Spinner-Farbe', fr: 'Couleur du spinner', es: 'Color del spinner', ru: 'Цвет спиннера', zh: '旋转器颜色', ja: 'スピナー色', it: 'Colore spinner', pt: 'Cor do spinner', ko: '스피너 색상', ar: 'لون الدوار', az: 'Spinner rəngi'
            },
            'background_color': {
                tr: 'Arkaplan Rengi', en: 'Background Color', de: 'Hintergrundfarbe', fr: 'Couleur d\'arrière-plan', es: 'Color de fondo', ru: 'Цвет фона', zh: '背景颜色', ja: '背景色', it: 'Colore sfondo', pt: 'Cor de fundo', ko: '배경색', ar: 'لون الخلفية', az: 'Arxa fon rəngi'
            },
            'text_color': {
                tr: 'Metin Rengi', en: 'Text Color', de: 'Textfarbe', fr: 'Couleur du texte', es: 'Color del texto', ru: 'Цвет текста', zh: '文本颜色', ja: 'テキスト色', it: 'Colore testo', pt: 'Cor do texto', ko: '텍스트 색상', ar: 'لون النص', az: 'Mətn rəngi'
            },
            'spinner_settings': {
                tr: 'Spinner Ayarları', en: 'Spinner Settings', de: 'Spinner-Einstellungen', fr: 'Paramètres du spinner', es: 'Configuración del spinner', ru: 'Настройки спиннера', zh: '旋转器设置', ja: 'スピナー設定', it: 'Impostazioni spinner', pt: 'Configurações do spinner', ko: '스피너 설정', ar: 'إعدادات الدوار', az: 'Spinner parametrləri'
            },
            'spinner_size': {
                tr: 'Spinner Boyutu', en: 'Spinner Size', de: 'Spinner-Größe', fr: 'Taille du spinner', es: 'Tamaño del spinner', ru: 'Размер спиннера', zh: '旋转器大小', ja: 'スピナーサイズ', it: 'Dimensione spinner', pt: 'Tamanho do spinner', ko: '스피너 크기', ar: 'حجم الدوار', az: 'Spinner ölçüsü'
            },
            'spinner_speed': {
                tr: 'Spinner Hızı', en: 'Spinner Speed', de: 'Spinner-Geschwindigkeit', fr: 'Vitesse du spinner', es: 'Velocidad del spinner', ru: 'Скорость спиннера', zh: '旋转器速度', ja: 'スピナーの速度', it: 'Velocità spinner', pt: 'Velocidade do spinner', ko: '스피너 속도', ar: 'سرعة الدوار', az: 'Spinner sürəti'
            },
            'background_settings': {
                tr: 'Arkaplan Ayarları', en: 'Background Settings', de: 'Hintergrund-Einstellungen', fr: 'Paramètres d\'arrière-plan', es: 'Configuración de fondo', ru: 'Настройки фона', zh: '背景设置', ja: '背景設定', it: 'Impostazioni sfondo', pt: 'Configurações de fundo', ko: '배경 설정', ar: 'إعدادات الخلفية', az: 'Arxa fon parametrləri'
            },
            'background_opacity': {
                tr: 'Arkaplan Şeffaflığı', en: 'Background Opacity', de: 'Hintergrund-Deckkraft', fr: 'Opacité d\'arrière-plan', es: 'Opacidad de fondo', ru: 'Прозрачность фона', zh: '背景透明度', ja: '背景の不透明度', it: 'Opacità sfondo', pt: 'Opacidade do fundo', ko: '배경 투명도', ar: 'شفافية الخلفية', az: 'Arxa fon şəffaflığı'
            },
            'blur_effect': {
                tr: 'Bulut Efekti', en: 'Blur Effect', de: 'Unschärfe-Effekt', fr: 'Effet de flou', es: 'Efecto de desenfoque', ru: 'Эффект размытия', zh: '模糊效果', ja: 'ぼかし効果', it: 'Effetto sfocatura', pt: 'Efeito de desfoque', ko: '블러 효과', ar: 'تأثير الضبابية', az: 'Bulud effekti'
            },
            'animation_settings': {
                tr: 'Animasyon Ayarları', en: 'Animation Settings', de: 'Animations-Einstellungen', fr: 'Paramètres d\'animation', es: 'Configuración de animación', ru: 'Настройки анимации', zh: '动画设置', ja: 'アニメーション設定', it: 'Impostazioni animazione', pt: 'Configurações de animação', ko: '애니메이션 설정', ar: 'إعدادات الرسوم المتحركة', az: 'Animasiya parametrləri'
            },
            'pulse_animation': {
                tr: 'Nabız Animasyonu', en: 'Pulse Animation', de: 'Puls-Animation', fr: 'Animation de pulsation', es: 'Animación de pulso', ru: 'Пульсирующая анимация', zh: '脉冲动画', ja: 'パルスアニメーション', it: 'Animazione pulsante', pt: 'Animação de pulso', ko: '펄스 애니메이션', ar: 'رسوم متحركة نابضة', az: 'Nabız animasiyası'
            },
            'text_glow': {
                tr: 'Metin Parlaması', en: 'Text Glow', de: 'Text-Leuchten', fr: 'Lueur du texte', es: 'Resplandor del texto', ru: 'Свечение текста', zh: '文本发光', ja: 'テキストグロー', it: 'Bagliore testo', pt: 'Brilho do texto', ko: '텍스트 글로우', ar: 'توهج النص', az: 'Mətn parıltısı'
            },
            'spinner_glow': {
                tr: 'Spinner Parlaması', en: 'Spinner Glow', de: 'Spinner-Leuchten', fr: 'Lueur du spinner', es: 'Resplandor del spinner', ru: 'Свечение спиннера', zh: '旋转器发光', ja: 'スピナーのグロー', it: 'Bagliore spinner', pt: 'Brilho do spinner', ko: '스피너 글로우', ar: 'توهج الدوار', az: 'Spinner parıltısı'
            },
            'text_settings': {
                tr: 'Metin Ayarları', en: 'Text Settings', de: 'Text-Einstellungen', fr: 'Paramètres du texte', es: 'Configuración del texto', ru: 'Настройки текста', zh: '文本设置', ja: 'テキスト設定', it: 'Impostazioni testo', pt: 'Configurações do texto', ko: '텍스트 설정', ar: 'إعدادات النص', az: 'Mətn parametrləri'
            },
            'text_size': {
                tr: 'Metin Boyutu', en: 'Text Size', de: 'Textgröße', fr: 'Taille du texte', es: 'Tamaño del texto', ru: 'Размер текста', zh: '文本大小', ja: 'テキストサイズ', it: 'Dimensione testo', pt: 'Tamanho do texto', ko: '텍스트 크기', ar: 'حجم النص', az: 'Mətn ölçüsü'
            },
            'text_weight': {
                tr: 'Metin Kalınlığı', en: 'Text Weight', de: 'Textgewicht', fr: 'Poids du texte', es: 'Peso del texto', ru: 'Толщина текста', zh: '文本粗细', ja: 'テキストの太さ', it: 'Peso testo', pt: 'Peso do texto', ko: '텍스트 굵기', ar: 'سمك النص', az: 'Mətn qalınlığı'
            },
            'text_weight_light': {
                tr: 'İnce', en: 'Light', de: 'Dünn', fr: 'Léger', es: 'Ligero', ru: 'Тонкий', zh: '细', ja: '細い', it: 'Sottile', pt: 'Leve', ko: '가벼움', ar: 'خفيف', az: 'İncə'
            },
            'text_weight_normal': {
                tr: 'Normal', en: 'Normal', de: 'Normal', fr: 'Normal', es: 'Normal', ru: 'Обычный', zh: '正常', ja: '通常', it: 'Normale', pt: 'Normal', ko: '보통', ar: 'عادي', az: 'Normal'
            },
            'text_weight_semibold': {
                tr: 'Yarı Kalın', en: 'Semi Bold', de: 'Halbfett', fr: 'Semi-gras', es: 'Semi-negrita', ru: 'Полужирный', zh: '半粗', ja: 'セミボールド', it: 'Semi-grassetto', pt: 'Semi-negrito', ko: '세미볼드', ar: 'نصف عريض', az: 'Yarı qalın'
            },
            'text_weight_bold': {
                tr: 'Kalın', en: 'Bold', de: 'Fett', fr: 'Gras', es: 'Negrita', ru: 'Жирный', zh: '粗', ja: '太い', it: 'Grassetto', pt: 'Negrito', ko: '굵음', ar: 'عريض', az: 'Qalın'
            },
            'text_weight_extrabold': {
                tr: 'Çok Kalın', en: 'Extra Bold', de: 'Extrafett', fr: 'Extra-gras', es: 'Extra-negrita', ru: 'Сверхжирный', zh: '特粗', ja: 'エクストラボールド', it: 'Extra-grassetto', pt: 'Extra-negrito', ko: '매우굵음', ar: 'عريض جداً', az: 'Çox qalın'
            },
            'loading_presets': {
                tr: 'Yükleme Ekranı Hazır Temaları', en: 'Loading Screen Presets', de: 'Ladebildschirm-Voreinstellungen', fr: 'Préréglages d\'écran de chargement', es: 'Preajustes de pantalla de carga', ru: 'Предустановки экрана загрузки', zh: '加载屏幕预设', ja: 'ローディング画面プリセット', it: 'Preset schermata di caricamento', pt: 'Predefinições da tela de carregamento', ko: '로딩 화면 사전 설정', ar: 'إعدادات شاشة التحميل المسبقة', az: 'Yükləmə ekranı hazır temaları'
            },
            'loading_preset_default': {
                tr: 'Varsayılan', en: 'Default', de: 'Standard', fr: 'Par défaut', es: 'Predeterminado', ru: 'По умолчанию', zh: '默认', ja: 'デフォルト', it: 'Predefinito', pt: 'Padrão', ko: '기본값', ar: 'افتراضي', az: 'Varsayılan'
            },
            'loading_preset_dark': {
                tr: 'Karanlık', en: 'Dark', de: 'Dunkel', fr: 'Sombre', es: 'Oscuro', ru: 'Тёмный', zh: '深色', ja: 'ダーク', it: 'Scuro', pt: 'Escuro', ko: '다크', ar: 'داكن', az: 'Qaranlıq'
            },
            'neon': {
                tr: 'Neon', en: 'Neon', de: 'Neon', fr: 'Néon', es: 'Neón', ru: 'Неон', zh: '霓虹', ja: 'ネオン', it: 'Neon', pt: 'Neon', ko: '네온', ar: 'نيون', az: 'Neon'
            },
            'minimal': {
                tr: 'Minimal', en: 'Minimal', de: 'Minimal', fr: 'Minimal', es: 'Minimal', ru: 'Минимальный', zh: '极简', ja: 'ミニマル', it: 'Minimale', pt: 'Minimal', ko: '미니멀', ar: 'الحد الأدنى', az: 'Minimal'
            },
            'gaming': {
                tr: 'Gaming', en: 'Gaming', de: 'Gaming', fr: 'Gaming', es: 'Gaming', ru: 'Игровой', zh: '游戏', ja: 'ゲーミング', it: 'Gaming', pt: 'Gaming', ko: '게이밍', ar: 'الألعاب', az: 'Gaming'
            },
            'elegant': {
                tr: 'Zarif', en: 'Elegant', de: 'Elegant', fr: 'Élégant', es: 'Elegante', ru: 'Элегантный', zh: '优雅', ja: 'エレガント', it: 'Elegante', pt: 'Elegante', ko: '우아한', ar: 'أنيق', az: 'Zərif'
            },
            'test_loading': {
                tr: 'Test Et', en: 'Test', de: 'Testen', fr: 'Tester', es: 'Probar', ru: 'Тест', zh: '测试', ja: 'テスト', it: 'Testa', pt: 'Testar', ko: '테스트', ar: 'اختبار', az: 'Test et'
            }
        };
        return dict[key] && dict[key][lang] ? dict[key][lang] : dict[key]?.tr || key;
    }

    renderSettingsPage() {
        const settingsContainer = document.getElementById('settings-page');
        if (!settingsContainer) return;
        
        if (!this.config) {
            console.log('Config henüz yüklenmedi, ayarlar sayfası render edilemiyor');
            return;
        }
        
        const currentVersion = (window?.process?.versions?.electron && window?.require?.main?.module?.exports) ? '' : '';
        const theme = this.getCurrentTheme();
        settingsContainer.innerHTML = `
            <div class="language-select-label">${this.translate('language')}</div>
            <div class="language-select-list">
                ${Object.keys(languageFlagUrls).map(lang => {
                    const configLang = this.config?.selectedLang;
                    const localLang = localStorage.getItem('selectedLang');
                    const currentLang = configLang || localLang || 'tr';
                    const isSelected = currentLang === lang;
                    
                    console.log(`Dil butonu render: ${lang}, Config: ${configLang}, Local: ${localLang}, Current: ${currentLang}, Selected: ${isSelected}`);
                    
                    const langNames = {
                        tr: 'Türkçe',
                        en: 'English',
                        de: 'Deutsch',
                        fr: 'Français',
                        es: 'Español',
                        ru: 'Русский',
                        zh: '中文',
                        ja: '日本語',
                        it: 'Italiano',
                        pt: 'Português',
                        ko: '한국어',
                        pl: 'Polski',
                        az: 'Azərbaycan dili'
                    };
                    
                    return `
                        <button class="lang-btn${isSelected ? ' selected' : ''}" data-lang="${lang}">
                        <img class="flag" src="${languageFlagUrls[lang]}" alt="${lang} flag" width="28" height="20" style="border-radius:4px;box-shadow:0 1px 4px #0002;vertical-align:middle;" />
                        <span class="lang-name">${langNames[lang]}</span>
                    </button>
                    `;
                }).join('')}
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
                    <span style="opacity:.8;" data-i18n="version">Sürüm:</span>
                    <span id="appVersion" data-i18n="loading">Yükleniyor...</span>
                    <a id="releaseLink" href="#" target="_blank" style="margin-left:8px;color:#00bfff;" data-i18n="github">GitHub</a>
                </div>
            </div>

            <div class="settings-section theme-designer compact" id="themeDesigner">
                <div class="theme-header">
                    <div>
                        <div class="theme-title" data-i18n="theme">Tema</div>
                        <div class="theme-sub" data-i18n="quick_settings">Hızlı ayarlar</div>
                    </div>
                    <button id="toggleAdvancedTheme" class="advanced-toggle" title="advanced_editing">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 1 1-2.83-2.83l.06.06A1.65 1.65 0 0 0 5 15.4a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 5 8.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8.6 5a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 16 5a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19 8.6a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19 15.4z"/></svg>
                        <span data-i18n="advanced">Gelişmiş</span>
                    </button>
                </div>
                <div class="theme-presets" id="themePresets"></div>
                <div class="mini-grid" id="miniGrid"></div>
                <div class="theme-grid" id="colorGrid" style="display:none"></div>
                <div class="theme-actions">
                    <button id="themeSave" class="action-btn primary"><span data-i18n="save">Kaydet</span></button>
                    <button id="themeReset" class="action-btn"><span data-i18n="reset">Sıfırla</span></button>
                    <button id="themeExport" class="action-btn"><span data-i18n="export">Dışa Aktar</span></button>
                    <label class="action-btn" style="cursor:pointer;" data-i18n="import">
                        İçe Aktar
                        <input id="themeImport" type="file" accept="application/json" style="display:none;" />
                    </label>
                    <button id="customizeIconsBtn" class="icon-customize-btn">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                            <path d="M12 2v2"/>
                            <path d="M12 20v2"/>
                            <path d="M4.93 4.93l1.41 1.41"/>
                            <path d="M17.66 17.66l1.41 1.41"/>
                            <path d="M2 12h2"/>
                            <path d="M20 12h2"/>
                            <path d="M6.34 17.66l-1.41 1.41"/>
                            <path d="M19.07 4.93l-1.41 1.41"/>
                        </svg>
                        <span data-i18n="customize_icons">İkonları Özelleştir</span>
                    </button>
                </div>
                <div class="icon-designer" id="iconDesigner">
                    <div class="icon-designer-header">
                        <h3 data-i18n="icon_customization">İkon Özelleştirme</h3>
                        <div class="icon-designer-actions">
                            <button class="designer-action-btn save" id="saveIconsBtn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
                                    <polyline points="17,21 17,13 7,13 7,21"/>
                                    <polyline points="7,3 7,8 15,8"/>
                        </svg>
                                <span data-i18n="save">Kaydet</span>
                            </button>
                            <button class="designer-action-btn reset" id="resetIconsBtn">
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="1,4 1,10 7,10"/>
                                    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/>
                                </svg>
                                <span data-i18n="reset">Sıfırla</span>
                    </button>
                </div>
                    </div>

                    <div class="icon-category-tabs">
                        <button class="icon-tab active" data-tab="bubble" data-i18n="bubble_menu">Bubble Menu</button>
                        <button class="icon-tab" data-tab="hamburger" data-i18n="hamburger_menu">Hamburger</button>
                    </div>



                    <!-- Bubble Menu Icons Tab -->
                    <div class="icon-tab-content active" id="bubbleTab">
                        <div class="icon-category modern">
                            <div class="category-header">
                                <h4 data-i18n="bubble_menu_icons">Bubble Menü İkonları</h4>
                            <div class="icon-preview-container">
                                    <div class="bubble-menu-preview">
                                        <div class="preview-bubble-item" data-icon="home">
                                            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                                                <polyline points="9,22 9,12 15,12 15,22"/>
                                            </svg>
                                    </div>
                                        <div class="preview-bubble-item" data-icon="repairFix">
                                            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                                <path d="M3 7l9-4 9 4-9 4-9-4z"/>
                                                <path d="M3 17l9 4 9-4"/>
                                                <path d="M3 12l9 4 9-4"/>
                                            </svg>
                                </div>
                                        <div class="preview-bubble-item" data-icon="bypass">
                                            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                                                <path d="M12 2v2"/>
                                                <path d="M12 20v2"/>
                                                <path d="M4.93 4.93l1.41 1.41"/>
                                                <path d="M17.66 17.66l1.41 1.41"/>
                                                <path d="M2 12h2"/>
                                                <path d="M20 12h2"/>
                                                <path d="M6.34 17.66l-1.41 1.41"/>
                                                <path d="M19.07 4.93l-1.41 1.41"/>
                                            </svg>
                                </div>
                                        <div class="preview-bubble-item" data-icon="library">
                                            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                                                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                                            </svg>
                            </div>
                                        <div class="preview-bubble-item" data-icon="manualInstall">
                                            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                                <polyline points="7,10 12,15 17,10"/>
                                                <line x1="12" y1="15" x2="12" y2="3"/>
                                            </svg>
                                </div>
                                        <div class="preview-bubble-item" data-icon="settings">
                                            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                                <circle cx="12" cy="12" r="3"/>
                                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 1 1-2.83-2.83l.06.06A1.65 1.65 0 0 0 5 15.4a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 5 8.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8.6 5a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 16 5a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19 8.6a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19 15.4z"/>
                                            </svg>
                                </div>
                                </div>
                                </div>
                            </div>

                            <!-- Home Icon -->
                            <div class="icon-subcategory compact">
                                <div class="subcategory-header">
                                    <h5 data-i18n="home_icon">Ana Sayfa İkonu</h5>
                                    <div class="single-icon-preview">
                                        <div class="preview-bubble-item home-single">
                                            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                                <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
                                                <polyline points="9,22 9,12 15,12 15,22"/>
                                            </svg>
                                        </div>
                                    </div>
                                </div>
                                <div class="icon-controls-grid">
                                    <div class="color-input-group">
                                        <label data-i18n="icon">İkon</label>
                                        <input id="bubbleHomeIconColor" type="color" value="${this.toHexColor(theme['--bubble-home-icon-color'] || '#a1a1aa')}" />
                                    </div>
                                    <div class="color-input-group">
                                        <label data-i18n="background">Arka Plan</label>
                                        <input id="bubbleHomeIconBg" type="color" value="${this.toHexColor(theme['--bubble-home-icon-bg'] || 'transparent')}" />
                                    </div>

                                                                        <div class="color-input-group">
                                        <label data-i18n="hover_background">Hover Arka Plan</label>
                                        <input id="bubbleHomeIconHoverBg" type="color" value="${this.toHexColor(theme['--bubble-home-icon-hover-bg'] || '#00d4ff')}" />
                                    </div>
                                    <div class="color-input-group">
                                        <label data-i18n="glow_effect">Glow Efekti</label>
                                        <input id="bubbleHomeIconGlow" type="color" value="${this.toHexColor(theme['--bubble-home-icon-glow'] || '#00d4ff')}" />
                                    </div>
                            </div>
                        </div>

                            <!-- Repair Fix Icon -->
                            <div class="icon-subcategory compact">
                                <div class="subcategory-header">
                                    <h5 data-i18n="repair_fix_icon">Çevrimiçi Düzeltme İkonu</h5>
                                    <div class="single-icon-preview">
                                        <div class="preview-bubble-item repairfix-single">
                                            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                                <path d="M3 7l9-4 9 4-9 4-9-4z"/>
                                                <path d="M3 17l9 4 9-4"/>
                                                <path d="M3 12l9 4 9-4"/>
                                            </svg>
                                    </div>
                                </div>
                            </div>
                                <div class="icon-controls-grid">
                                    <div class="color-input-group">
                                        <label data-i18n="icon">İkon</label>
                                        <input id="bubbleRepairFixIconColor" type="color" value="${this.toHexColor(theme['--bubble-repairfix-icon-color'] || '#a1a1aa')}" />
                                </div>
                                    <div class="color-input-group">
                                        <label data-i18n="background">Arka Plan</label>
                                        <input id="bubbleRepairFixIconBg" type="color" value="${this.toHexColor(theme['--bubble-repairfix-icon-bg'] || 'transparent')}" />
                                </div>

                                                                        <div class="color-input-group">
                                        <label data-i18n="hover_background">Hover Arka Plan</label>
                                        <input id="bubbleRepairFixIconHoverBg" type="color" value="${this.toHexColor(theme['--bubble-repairfix-icon-hover-bg'] || '#00d4ff')}" />
                                    </div>
                                    <div class="color-input-group">
                                        <label data-i18n="glow_effect">Glow Efekti</label>
                                        <input id="bubbleRepairFixIconGlow" type="color" value="${this.toHexColor(theme['--bubble-repairfix-icon-glow'] || '#ff6b6b')}" />
                                    </div>
                            </div>
                        </div>

                            <!-- Bypass Icon -->
                            <div class="icon-subcategory compact">
                                <div class="subcategory-header">
                                    <h5 data-i18n="bypass_icon">Bypass İkonu</h5>
                                    <div class="single-icon-preview">
                                        <div class="preview-bubble-item bypass-single">
                                            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
                                                <path d="M12 2v2"/>
                                                <path d="M12 20v2"/>
                                                <path d="M4.93 4.93l1.41 1.41"/>
                                                <path d="M17.66 17.66l1.41 1.41"/>
                                                <path d="M2 12h2"/>
                                                <path d="M20 12h2"/>
                                                <path d="M6.34 17.66l-1.41 1.41"/>
                                                <path d="M19.07 4.93l-1.41 1.41"/>
                                            </svg>
                                        </div>
                                    </div>
                                </div>
                                <div class="icon-controls-grid">
                                    <div class="color-input-group">
                                        <label data-i18n="icon">İkon</label>
                                        <input id="bubbleBypassIconColor" type="color" value="${this.toHexColor(theme['--bubble-bypass-icon-color'] || '#a1a1aa')}" />
                                    </div>
                                    <div class="color-input-group">
                                        <label data-i18n="background">Arka Plan</label>
                                        <input id="bubbleBypassIconBg" type="color" value="${this.toHexColor(theme['--bubble-bypass-icon-bg'] || 'transparent')}" />
                                    </div>
                                    <div class="color-input-group">
                                        <label data-i18n="hover_background">Hover Arka Plan</label>
                                        <input id="bubbleBypassIconHoverBg" type="color" value="${this.toHexColor(theme['--bubble-bypass-icon-hover-bg'] || '#00d4ff')}" />
                                    </div>
                                    <div class="color-input-group">
                                        <label data-i18n="glow_effect">Glow Efekti</label>
                                        <input id="bubbleBypassIconGlow" type="color" value="${this.toHexColor(theme['--bubble-bypass-icon-glow'] || '#ff6b6b')}" />
                                    </div>
                            </div>
                        </div>

                            <!-- Library Icon -->
                            <div class="icon-subcategory compact">
                                <div class="subcategory-header">
                                    <h5 data-i18n="library_icon">Kütüphane İkonu</h5>
                                    <div class="single-icon-preview">
                                        <div class="preview-bubble-item library-single">
                                            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/>
                                                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>
                                            </svg>
                                        </div>
                                    </div>
                                </div>
                                <div class="icon-controls-grid">
                                    <div class="color-input-group">
                                        <label data-i18n="icon">İkon</label>
                                        <input id="bubbleLibraryIconColor" type="color" value="${this.toHexColor(theme['--bubble-library-icon-color'] || '#a1a1aa')}" />
                                    </div>
                                    <div class="color-input-group">
                                        <label data-i18n="background">Arka Plan</label>
                                        <input id="bubbleLibraryIconBg" type="color" value="${this.toHexColor(theme['--bubble-library-icon-bg'] || 'transparent')}" />
                                    </div>

                                    <div class="color-input-group">
                                        <label data-i18n="hover_background">Hover Arka Plan</label>
                                        <input id="bubbleLibraryIconHoverBg" type="color" value="${this.toHexColor(theme['--bubble-library-icon-hover-bg'] || '#00d4ff')}" />
                                    </div>
                                    <div class="color-input-group">
                                        <label data-i18n="glow_effect">Glow Efekti</label>
                                        <input id="bubbleLibraryIconGlow" type="color" value="${this.toHexColor(theme['--bubble-library-icon-glow'] || '#4ecdc4')}" />
                                    </div>
                                </div>
                            </div>

                            <!-- Manual Install Icon -->
                            <div class="icon-subcategory compact">
                                <div class="subcategory-header">
                                    <h5 data-i18n="manual_install_icon">Manuel Kurulum İkonu</h5>
                                    <div class="single-icon-preview">
                                        <div class="preview-bubble-item manualinstall-single">
                                            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                                <polyline points="7,10 12,15 17,10"/>
                                                <line x1="12" y1="15" x2="12" y2="3"/>
                                            </svg>
                                        </div>
                                    </div>
                                </div>
                                <div class="icon-controls-grid">
                                    <div class="color-input-group">
                                        <label data-i18n="icon">İkon</label>
                                        <input id="bubbleManualInstallIconColor" type="color" value="${this.toHexColor(theme['--bubble-manualinstall-icon-color'] || '#a1a1aa')}" />
                                    </div>
                                    <div class="color-input-group">
                                        <label data-i18n="background">Arka Plan</label>
                                        <input id="bubbleManualInstallIconBg" type="color" value="${this.toHexColor(theme['--bubble-manualinstall-icon-bg'] || 'transparent')}" />
                                    </div>

                                    <div class="color-input-group">
                                        <label data-i18n="hover_background">Hover Arka Plan</label>
                                        <input id="bubbleManualInstallIconHoverBg" type="color" value="${this.toHexColor(theme['--bubble-manualinstall-icon-hover-bg'] || '#00d4ff')}" />
                                    </div>
                                    <div class="color-input-group">
                                        <label data-i18n="glow_effect">Glow Efekti</label>
                                        <input id="bubbleManualInstallIconGlow" type="color" value="${this.toHexColor(theme['--bubble-manualinstall-icon-glow'] || '#ffa726')}" />
                                    </div>
                                </div>
                            </div>

                            <!-- Settings Icon -->
                            <div class="icon-subcategory compact">
                                <div class="subcategory-header">
                                    <h5 data-i18n="settings_icon">Ayarlar İkonu</h5>
                                    <div class="single-icon-preview">
                                        <div class="preview-bubble-item settings-single">
                                            <svg width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                                                <circle cx="12" cy="12" r="3"/>
                                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 1 1-2.83-2.83l.06.06A1.65 1.65 0 0 0 5 15.4a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 5 8.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8.6 5a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 16 5a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19 8.6a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19 15.4z"/>
                                            </svg>
                                        </div>
                                    </div>
                                </div>
                                <div class="icon-controls-grid">
                                    <div class="color-input-group">
                                        <label data-i18n="icon">İkon</label>
                                        <input id="bubbleSettingsIconColor" type="color" value="${this.toHexColor(theme['--bubble-settings-icon-color'] || '#a1a1aa')}" />
                                    </div>
                                    <div class="color-input-group">
                                        <label data-i18n="background">Arka Plan</label>
                                        <input id="bubbleSettingsIconBg" type="color" value="${this.toHexColor(theme['--bubble-settings-icon-bg'] || 'transparent')}" />
                                    </div>

                                    <div class="color-input-group">
                                        <label data-i18n="hover_background">Hover Arka Plan</label>
                                        <input id="bubbleSettingsIconHoverBg" type="color" value="${this.toHexColor(theme['--bubble-settings-icon-hover-bg'] || '#00d4ff')}" />
                                    </div>
                                    <div class="color-input-group">
                                        <label data-i18n="glow_effect">Glow Efekti</label>
                                        <input id="bubbleSettingsIconGlow" type="color" value="${this.toHexColor(theme['--bubble-settings-icon-glow'] || '#ab47bc')}" />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Hamburger Menu Tab -->
                    <div class="icon-tab-content" id="hamburgerTab">
                        <div class="icon-category modern">
                            <div class="category-header">
                                <h4 data-i18n="hamburger_menu">Hamburger Menü</h4>
                            <div class="icon-preview-container">
                                    <div class="hamburger-preview">
                                    <div class="preview-hamburger">
                                        <div class="hamburger-line"></div>
                                        <div class="hamburger-line"></div>
                                        <div class="hamburger-line"></div>
                                    </div>
                                </div>
                            </div>
                            </div>

                            <div class="icon-subcategory compact">
                                <div class="subcategory-header">
                                    <h5 data-i18n="hamburger_button">☰ Hamburger Butonu</h5>
                                    <div class="single-icon-preview">
                                        <div class="preview-hamburger single">
                                            <div class="hamburger-line"></div>
                                            <div class="hamburger-line"></div>
                                            <div class="hamburger-line"></div>
                                        </div>
                                    </div>
                                </div>
                                <div class="icon-controls-grid">
                                    <div class="color-input-group">
                                        <label data-i18n="line_color">Çizgi Rengi</label>
                                    <input id="hamburgerColor" type="color" value="${this.toHexColor(theme['--hamburger-color'] || '#a1a1aa')}" />
                                </div>

                                    <div class="color-input-group">
                                        <label data-i18n="hover_color">Hover Rengi</label>
                                        <input id="hamburgerHoverColor" type="color" value="${this.toHexColor(theme['--hamburger-hover-color'] || '#ffffff')}" />
                            </div>

                                    <div class="color-input-group">
                                        <label data-i18n="line_thickness">Çizgi Kalınlığı</label>
                                        <input id="hamburgerLineWeight" type="range" min="1" max="5" value="${theme['--hamburger-line-weight'] || '2'}" />
                                        <span class="range-value">${theme['--hamburger-line-weight'] || '2'}px</span>
                    </div>
                                    <div class="color-input-group">
                                        <label data-i18n="line_gap">Çizgi Aralığı</label>
                                        <input id="hamburgerLineGap" type="range" min="0" max="10" value="${theme['--hamburger-line-gap'] || '3'}" />
                                        <span class="range-value">${theme['--hamburger-line-gap'] || '3'}px</span>
                </div>
                    </div>
                </div>
            </div>
            </div>


                </div>
            </div>
        `;

        settingsContainer.innerHTML += `
            <!-- Loading Screen Customization -->
            <div class="settings-section loading-designer compact" id="loadingDesigner">
                <div class="loading-header">
                    <div>
                        <div class="loading-title" data-i18n="loading_screen">Yükleme Ekranı</div>
                        <div class="loading-sub" data-i18n="loading_customization">Yükleme ekranı özelleştirme</div>
                    </div>
                    <button id="toggleAdvancedLoading" class="advanced-toggle" title="advanced_loading_editing">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="3"/>
                            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 8 19.4a1.65 1.65 0 0 0-1.82.33l-.06-.06a2 2 0 1 1-2.83-2.83l.06.06A1.65 1.65 0 0 0 5 15.4a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 5 8.6a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 8.6 5a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09A1.65 1.65 0 0 0 16 5a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19 8.6a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09A1.65 1.65 0 0 0 19 15.4z"/>
                        </svg>
                        <span data-i18n="advanced">Gelişmiş</span>
                    </button>
                </div>
                
                <!-- Loading Screen Preview -->
                <div class="loading-preview-container">
                    <div class="loading-preview" id="loadingPreview">
                        <div class="loading-preview-content">
                            <div class="loading-preview-spinner">
                                <div class="loading-preview-ring"></div>
                            </div>
                            <div class="loading-preview-text">Yükleme Ekranı Önizlemesi</div>
                        </div>
                    </div>
                </div>

                <!-- Quick Settings -->
                <div class="loading-quick-settings">
                    <div class="mini-grid">
                        <div class="mini-row">
                            <label data-i18n="spinner_color">Spinner Rengi</label>
                            <input type="color" id="loadingSpinnerColor" value="#00d4ff">
                        </div>
                        <div class="mini-row">
                            <label data-i18n="background_color">Arkaplan Rengi</label>
                            <input type="color" id="loadingBgColor" value="#0f0f0f">
                        </div>
                        <div class="mini-row">
                            <label data-i18n="text_color">Metin Rengi</label>
                            <input type="color" id="loadingTextColor" value="#ffffff">
                        </div>
                    </div>
                </div>

                <!-- Advanced Settings -->
                <div class="loading-advanced-settings" id="loadingAdvancedSettings" style="display:none;">
                    <div class="loading-settings-grid">
                        <div class="loading-setting-group">
                            <h4 data-i18n="spinner_settings">Spinner Ayarları</h4>
                            <div class="setting-row">
                                <label data-i18n="spinner_size">Spinner Boyutu</label>
                                <input type="range" id="loadingSpinnerSize" min="20" max="100" value="60">
                                <span class="range-value">60px</span>
                            </div>
                            <div class="setting-row">
                                <label data-i18n="spinner_speed">Spinner Hızı</label>
                                <input type="range" id="loadingSpinnerSpeed" min="0.5" max="3" step="0.1" value="1.2">
                                <span class="range-value">1.2s</span>
                            </div>
                        </div>

                        <div class="loading-setting-group">
                            <h4 data-i18n="background_settings">Arkaplan Ayarları</h4>
                            <div class="setting-row">
                                <label data-i18n="background_opacity">Arkaplan Şeffaflığı</label>
                                <input type="range" id="loadingBgOpacity" min="0" max="100" value="95">
                                <span class="range-value">95%</span>
                            </div>
                            <div class="setting-row">
                                <label data-i18n="blur_effect">Bulut Efekti</label>
                                <input type="range" id="loadingBlurEffect" min="0" max="30" value="20">
                                <span class="range-value">20px</span>
                            </div>
                        </div>

                        <div class="loading-setting-group">
                            <h4 data-i18n="animation_settings">Animasyon Ayarları</h4>
                            <div class="setting-row">
                                <label data-i18n="pulse_animation">Nabız Animasyonu</label>
                                <input type="checkbox" id="loadingPulseAnimation" checked>
                            </div>
                            <div class="setting-row">
                                <label data-i18n="text_glow">Metin Parlaması</label>
                                <input type="checkbox" id="loadingTextGlow" checked>
                            </div>
                            <div class="setting-row">
                                <label data-i18n="spinner_glow">Spinner Parlaması</label>
                                <input type="checkbox" id="loadingSpinnerGlow" checked>
                            </div>
                        </div>

                        <div class="loading-setting-group">
                            <h4 data-i18n="text_settings">Metin Ayarları</h4>
                            <div class="setting-row">
                                <label data-i18n="text_size">Metin Boyutu</label>
                                <input type="range" id="loadingTextSize" min="12" max="24" value="16">
                                <span class="range-value">16px</span>
                            </div>
                            <div class="setting-row">
                                <label data-i18n="text_weight">Metin Kalınlığı</label>
                                <select id="loadingTextWeight">
                                    <option value="300" data-i18n="text_weight_light">İnce</option>
                                    <option value="400" data-i18n="text_weight_normal">Normal</option>
                                    <option value="600" data-i18n="text_weight_semibold" selected>Yarı Kalın</option>
                                    <option value="700" data-i18n="text_weight_bold">Kalın</option>
                                    <option value="800" data-i18n="text_weight_extrabold">Çok Kalın</option>
                                </select>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Loading Presets -->
                <div class="loading-presets" id="loadingPresets">
                    <h4 data-i18n="loading_presets">Yükleme Ekranı Hazır Temaları</h4>
                    <div class="preset-buttons">
                        <button class="preset-btn" data-preset="default" data-i18n="loading_preset_default">Varsayılan</button>
                        <button class="preset-btn" data-preset="neon" data-i18n="neon">Neon</button>
                        <button class="preset-btn" data-preset="minimal" data-i18n="minimal">Minimal</button>
                        <button class="preset-btn" data-preset="gaming" data-i18n="gaming">Gaming</button>
                        <button class="preset-btn" data-preset="elegant" data-i18n="elegant">Zarif</button>
                        <button class="preset-btn" data-preset="dark" data-i18n="loading_preset_dark">Karanlık</button>
                    </div>
                </div>

                <div class="loading-actions">
                    <button id="loadingSave" class="action-btn primary"><span data-i18n="save">Kaydet</span></button>
                    <button id="loadingReset" class="action-btn"><span data-i18n="reset">Sıfırla</span></button>
                    <button id="loadingExport" class="action-btn"><span data-i18n="export">Dışa Aktar</span></button>
                    <label class="action-btn" style="cursor:pointer;" data-i18n="import">
                        İçe Aktar
                        <input id="loadingImport" type="file" accept="application/json" style="display:none;" />
                    </label>
                    <button id="testLoadingBtn" class="action-btn">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.85.9 6.67 2.4"/>
                            <path d="M21 3v9h-9"/>
                        </svg>
                        <span data-i18n="test_loading">Test Et</span>
                    </button>
                </div>
            </div>

            <!-- Notification Settings -->
            <div class="settings-section notification-settings" id="notificationSettings">
                <div class="notification-header">
                    <h3 data-i18n="notification_settings">Bildirim Ayarları</h3>
                    <p data-i18n="notification_customization">Bildirim görünümünü ve sesini özelleştir</p>
                </div>

                <!-- Core Settings -->
                <div class="notification-core-settings">
                    <div class="setting-group">
                        <h4 data-i18n="sound_settings">Ses Ayarları</h4>
                        <div class="setting-row">
                            <label data-i18n="sound_enabled">Ses Açık</label>
                            <div class="modern-toggle-container">
                                <input type="checkbox" id="notificationSoundEnabled" class="modern-toggle-input" checked>
                                <label for="notificationSoundEnabled" class="modern-toggle-label">
                                    <span class="modern-toggle-text on" data-i18n="sound_on">AÇIK</span>
                                    <span class="modern-toggle-switch"></span>
                                    <span class="modern-toggle-text off" data-i18n="sound_off">KAPALI</span>
                                </label>
                            </div>
                        </div>
                    </div>
                </div>
                
                <!-- Style Selection -->
                <div class="style-selection">
                    <h4 data-i18n="notification_styles">Bildirim Stilleri</h4>
                    <div class="style-grid">
                        <div class="style-item active" data-style="modern">
                            <div class="style-preview modern-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">💎</span>
                                    <span class="preview-text">Modern</span>
                                </div>
                            </div>
                            <span class="style-name" data-i18n="style_modern">Modern</span>
                    </div>



                        <div class="style-item" data-style="neon">
                            <div class="style-preview neon-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">⚡</span>
                                    <span class="preview-text">Neon</span>
                        </div>
                            </div>
                            <span class="style-name" data-i18n="style_neon">Neon</span>
                    </div>

                        <div class="style-item" data-style="glass">
                            <div class="style-preview glass-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">💠</span>
                                    <span class="preview-text">Cam</span>
                        </div>
                            </div>
                            <span class="style-name" data-i18n="style_glass">Cam Efekti</span>
                    </div>

                        <div class="style-item" data-style="retro">
                            <div class="style-preview retro-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">📺</span>
                                    <span class="preview-text">Retro</span>
                        </div>
                            </div>
                            <span class="style-name" data-i18n="style_retro">Retro</span>
                    </div>





                        <div class="style-item" data-style="minimal">
                            <div class="style-preview minimal-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">🔹</span>
                                    <span class="preview-text">Minimal</span>
                        </div>
                            </div>
                            <span class="style-name" data-i18n="style_minimal">Minimal</span>
                    </div>



                        <div class="style-item" data-style="steampunk">
                            <div class="style-preview steampunk-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">⚙️</span>
                                    <span class="preview-text">Steampunk</span>
                                </div>
                            </div>
                            <span class="style-name" data-i18n="style_steampunk">Steampunk</span>
                    </div>

                        <div class="style-item" data-style="hologram">
                            <div class="style-preview hologram-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">🌈</span>
                                    <span class="preview-text">Hologram</span>
                                </div>
                            </div>
                            <span class="style-name" data-i18n="style_hologram">Hologram</span>
                    </div>

                        <div class="style-item" data-style="matrix">
                            <div class="style-preview matrix-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">🟢</span>
                                    <span class="preview-text">Matrix</span>
                                </div>
                            </div>
                            <span class="style-name" data-i18n="style_matrix">Matrix</span>
                    </div>

                        <div class="style-item" data-style="gradient">
                            <div class="style-preview gradient-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">🎨</span>
                                    <span class="preview-text">Gradient</span>
                        </div>
                            </div>
                            <span class="style-name" data-i18n="style_gradient">Gradient</span>
                    </div>

                        <div class="style-item" data-style="cosmic">
                            <div class="style-preview cosmic-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">🌌</span>
                                    <span class="preview-text">Kozmik</span>
                    </div>
                </div>
                            <span class="style-name" data-i18n="style_cosmic">Kozmik</span>
            </div>

                        <div class="style-item" data-style="ice">
                            <div class="style-preview ice-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">❄️</span>
                                    <span class="preview-text">Buz</span>
                                </div>
                            </div>
                            <span class="style-name" data-i18n="style_ice">Buz</span>
                        </div>

                        <div class="style-item" data-style="golden">
                            <div class="style-preview golden-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">✨</span>
                                    <span class="preview-text">Altın</span>
                                </div>
                            </div>
                            <span class="style-name" data-i18n="style_golden">Altın</span>
                        </div>

                        <div class="style-item" data-style="vintage">
                            <div class="style-preview vintage-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">📷</span>
                                    <span class="preview-text">Vintage</span>
                                </div>
                            </div>
                            <span class="style-name" data-i18n="style_vintage">Vintage</span>
                        </div>

                        <div class="style-item" data-style="futuristic">
                            <div class="style-preview futuristic-style">
                                <div class="preview-notification">
                                    <span class="preview-icon">🚀</span>
                                    <span class="preview-text">Futuristik</span>
                                </div>
                            </div>
                            <span class="style-name" data-i18n="style_futuristic">Futuristik</span>
                        </div>
                    </div>
                </div>

                <!-- Action Buttons -->
                <div class="action-section">
                    <button id="notificationExport" class="btn btn-outline" data-i18n="export_settings">Dışa Aktar</button>
                    <label class="btn btn-outline import-btn">
                        <span data-i18n="import_settings">İçe Aktar</span>
                        <input id="notificationImport" type="file" accept="application/json" hidden>
                    </label>
                </div>
            </div>


        `;
        
        const langBtns = settingsContainer.querySelectorAll('.lang-btn');
        langBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const lang = btn.dataset.lang;
                this.setCurrentLanguage(lang);
            });
        });
        
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

        this.loadAndRenderVersionInfo();

        this.renderThemePresets();
        this.renderMiniRows({});
        this.renderColorRows({});
        
        setTimeout(() => {
            this.updateMiniGridFromCurrentCSS();
            this.updateAdvancedColorsFromCurrentCSS();
        }, 100);
        const updateTheme = this.throttle((cssVar, value) => {
            document.documentElement.style.setProperty(cssVar, value);
        }, 16);
        
        settingsContainer.querySelectorAll('input[type="color"]').forEach(inp => {
            inp.addEventListener('input', () => {
                updateTheme(inp.dataset.var, inp.value);
            });
        });
        document.getElementById('toggleAdvancedTheme')?.addEventListener('click', () => this.toggleAdvancedTheme());

        document.getElementById('themeSave')?.addEventListener('click', () => this.saveCurrentTheme());
        document.getElementById('themeReset')?.addEventListener('click', () => this.resetThemeToDefault());
        document.getElementById('themeExport')?.addEventListener('click', () => this.exportTheme());
        document.getElementById('themeImport')?.addEventListener('change', (e) => this.importTheme(e));
        document.getElementById('customizeIconsBtn')?.addEventListener('click', () => this.toggleIconDesigner());
        
        const iconDesigner = document.getElementById('iconDesigner');
        if (iconDesigner) {
            iconDesigner.classList.remove('active');
        }

        this.setupLoadingCustomization();
        
        this.setupEnhancedNotificationSettings();
        
        this.setupNotificationSettings();
        
        const settingsLangBtns = settingsContainer.querySelectorAll('.lang-btn');
        
        const localLang = localStorage.getItem('selectedLang');
        const configLang = this.config?.selectedLang;
        const currentSelectedLang = localLang || configLang || 'tr';
        
        console.log('Ayarlar sayfasında dil kontrol:', {
            localStorage: localLang,
            config: configLang,
            selected: currentSelectedLang
        });
        
        settingsLangBtns.forEach(btn => {
            const btnLang = btn.dataset.lang;
            console.log(`Buton kontrol: ${btnLang} === ${currentSelectedLang} ? ${btnLang === currentSelectedLang}`);
            
            if (btnLang === currentSelectedLang) {
                btn.classList.add('selected');
                console.log(`✅ Selected class eklendi: ${btnLang}`);
            } else {
                btn.classList.remove('selected');
                console.log(`❌ Selected class kaldırıldı: ${btnLang}`);
            }
            
            btn.addEventListener('click', async () => {
                settingsLangBtns.forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
                
                await this.updateConfigSilent({ selectedLang: btn.dataset.lang });
                localStorage.setItem('selectedLang', btn.dataset.lang);
                
                this.updateTranslations();
                this.updateLanguageIcon(btn.dataset.lang);
                
                setTimeout(() => {
                    this.renderSettingsPage();
                }, 100);
            });
        });
        
        this.applyTranslations();
    }

    applyTranslations() {
        try {
            const elements = document.querySelectorAll('[data-i18n]');
            elements.forEach(element => {
                const key = element.getAttribute('data-i18n');
                if (key) {
                    const translation = this.translate(key);
                    if (translation && translation !== key) {
                        element.textContent = translation;
                    }
                }
            });
            
            const elementsWithTitleI18n = document.querySelectorAll('[data-i18n-title]');
            elementsWithTitleI18n.forEach(element => {
                const titleKey = element.getAttribute('data-i18n-title');
                if (titleKey) {
                    const translation = this.translate(titleKey);
                    if (translation && translation !== titleKey) {
                        element.title = translation;
                    }
                }
            });
        } catch (error) {
            console.warn('Error applying translations:', error);
        }
    }

    renderColorRows(theme) {
        const colorGrid = document.getElementById('colorGrid');
        if (!colorGrid) return;
        const defs = [
            ['primary-bg','background_1'],
            ['secondary-bg','background_2'],
            ['tertiary-bg','background_3'],
            ['accent-primary','accent_1'],
            ['accent-secondary','accent_2'],
            ['text-primary','text_1'],
            ['text-secondary','text_2'],
            ['border-color','border']
        ];
        const getVal = (k) => theme[`--${k}`] || getComputedStyle(document.documentElement).getPropertyValue(`--${k}`).trim();
        colorGrid.innerHTML = defs.map(([key,label]) => {
            const v = this.toHexColor(getVal(key));
            const varName = `--${key}`;
            return `
            <div class="theme-row">
                <label for="color-${key}" data-i18n="${label}">${this.translate(label)}</label>
                <input id="color-${key}" type="color" value="${v}" data-var="${varName}" />
            </div>`;
        }).join('');
        
        this.applyTranslations();
    }

    renderMiniRows(theme) {
        const mini = document.getElementById('miniGrid');
        if (!mini) return;
        const defs = [
            ['accent-primary','accent'],
            ['primary-bg','background'],
            ['secondary-bg','top_bar'],
            ['card-hover','card_hover'],
            ['icon-color','icons']
        ];
        const getVal = (k) => theme[`--${k}`] || getComputedStyle(document.documentElement).getPropertyValue(`--${k}`).trim();
        mini.innerHTML = defs.map(([key,label]) => {
            const v = this.toHexColor(getVal(key));
            const varName = `--${key}`;
            return `
            <div class="mini-row">
                <label for="mini-${key}" data-i18n="${label}">${this.translate(label)}</label>
                <input id="mini-${key}" type="color" value="${v}" data-var="${varName}" />
            </div>`;
        }).join('');

        const updateMiniTheme = this.throttle((cssVar, value, key) => {
            document.documentElement.style.setProperty(cssVar, value);
            const adv = document.getElementById(`color-${key}`);
            if (adv) adv.value = value;
        }, 16);
        
        mini.querySelectorAll('input[type="color"]').forEach(inp => {
            inp.addEventListener('input', () => {
                const cssVar = inp.dataset.var;
                const key = cssVar.replace(/^--/, '');
                updateMiniTheme(cssVar, inp.value, key);
            });
        });
        
        this.applyTranslations();
    }

    toggleAdvancedTheme() {
        const grid = document.getElementById('colorGrid');
        const box = document.getElementById('themeDesigner');
        if (!grid || !box) return;
        const show = grid.style.display === 'none';
        grid.style.display = show ? '' : 'none';
        box.classList.toggle('compact', !show);
        const actions = box.querySelector('.theme-actions');
        if (actions) actions.classList.toggle('compact', !show);
    }

    throttle(func, wait) {
        let timeout;
        return function executedFunction(...args) {
            const later = () => {
                clearTimeout(timeout);
                func(...args);
            };
            clearTimeout(timeout);
            timeout = setTimeout(later, wait);
        };
    }

    toggleIconDesigner() {
        const toggle = document.getElementById('customizeIconsBtn');
        const designer = document.getElementById('iconDesigner');
        if (!toggle || !designer) {
            console.error('Icon designer elements not found!', { toggle, designer });
            return;
        }
        
        const isVisible = designer.classList.contains('active');
        const show = !isVisible;
        
        if (show) {
            designer.classList.add('active');
            toggle.classList.add('active');
            
            setTimeout(() => {
                this.setupIconDesigner();
                this.setupTabNavigation();
                this.setupActionButtons();
            }, 150);
        } else {
            designer.classList.remove('active');
            toggle.classList.remove('active');
        }
        
        console.log('Icon designer toggled:', { show, isActive: designer.classList.contains('active') });
    }

    setupIconDesigner() {
        console.log('Setting up icon designer...');
        
        const existingInputs = document.querySelectorAll('#iconDesigner input');
        existingInputs.forEach(input => {
            const newInput = input.cloneNode(true);
            input.parentNode.replaceChild(newInput, input);
        });
        
        const colorInputs = document.querySelectorAll('#iconDesigner input[type="color"]');
        console.log('Found color inputs:', colorInputs.length);
        colorInputs.forEach(input => {
            input.addEventListener('change', (e) => {
                console.log('Color changed:', e.target.id, e.target.value);
                this.updateIconColor(e.target.id, e.target.value);
            });
            
            input.addEventListener('input', (e) => {
                console.log('Color input:', e.target.id, e.target.value);
                this.updateIconColor(e.target.id, e.target.value);
            });
        });

        const rangeInputs = document.querySelectorAll('#iconDesigner input[type="range"]');
        console.log('Found range inputs:', rangeInputs.length);
        rangeInputs.forEach(input => {
            input.addEventListener('input', (e) => {
                console.log('Range changed:', e.target.id, e.target.value);
                this.updateIconRange(e.target.id, e.target.value);
            });
        });
        
        this.loadCurrentIconSettings();
        
        setTimeout(() => {
            this.refreshHoverStyles();
        }, 100);
    }

    loadCurrentIconSettings() {
        const savedSettings = this.config.iconSettings || {};
        
        Object.entries(savedSettings).forEach(([inputId, value]) => {
            const input = document.getElementById(inputId);
            if (input) {
                input.value = value;
                
                if (inputId.includes('Color') || inputId.includes('Bg')) {
                    this.updateIconColor(inputId, value);
                } else if (inputId.includes('Weight') || inputId.includes('Gap')) {
                    this.updateIconRange(inputId, value.replace('px', ''));
                }
            }
        });
        
        this.refreshHoverStyles();
        
        console.log('Loaded icon settings:', savedSettings);
    }

    setupTabNavigation() {
        const tabs = document.querySelectorAll('.icon-tab');
        const tabContents = document.querySelectorAll('.icon-tab-content');
        
        console.log('Setting up tab navigation...', tabs.length, 'tabs found');
        
        tabs.forEach(tab => {
            const newTab = tab.cloneNode(true);
            tab.parentNode.replaceChild(newTab, tab);
        });
        
        const newTabs = document.querySelectorAll('.icon-tab');
        
        newTabs.forEach(tab => {
            tab.addEventListener('click', () => {
                const targetTab = tab.dataset.tab;
                console.log('Tab clicked:', targetTab);
                
                newTabs.forEach(t => t.classList.remove('active'));
                tabContents.forEach(content => content.classList.remove('active'));
                
                tab.classList.add('active');
                const targetContent = document.getElementById(targetTab + 'Tab');
                if (targetContent) {
                    targetContent.classList.add('active');
                }
            });
        });
    }

    setupActionButtons() {
        console.log('Setting up action buttons...');
        
        const saveBtn = document.getElementById('saveIconsBtn');
        if (saveBtn) {
            const newSaveBtn = saveBtn.cloneNode(true);
            saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);
            
            newSaveBtn.addEventListener('click', () => {
                console.log('Save button clicked');
                this.saveIconSettings();
            });
        }

        const resetBtn = document.getElementById('resetIconsBtn');
        if (resetBtn) {
            const newResetBtn = resetBtn.cloneNode(true);
            resetBtn.parentNode.replaceChild(newResetBtn, resetBtn);
            
            newResetBtn.addEventListener('click', () => {
                console.log('Reset button clicked');
                this.resetIconSettings();
            });
        }
    }

    resetIconSettings() {
        try {
            const defaultPreset = this.getThemePresets()['Dark'];
            if (defaultPreset) {
                Object.entries(defaultPreset).forEach(([cssVar, value]) => {
                    document.documentElement.style.setProperty(cssVar, value);
                });
                
                const iconInputs = document.querySelectorAll('#iconDesigner input[type="color"]');
                iconInputs.forEach(input => {
                    const inputId = input.id;
                    if (inputId.includes('Icon')) {
                        const cssVar = `--${inputId.replace(/([A-Z])/g, '-$1').toLowerCase()}`;
                        const defaultValue = defaultPreset[cssVar];
                        if (defaultValue) {
                            input.value = this.toHexColor(defaultValue);
                        }
                    }
                });
                
                this.refreshHoverStyles();
                
                this.updateConfig({ themePreset: 'Dark', customTheme: defaultPreset });
                
                this.showNotification('success', 'İkon ayarları sıfırlandı', 'success');
            }
        } catch (error) {
            console.error('İkon ayarları sıfırlama hatası:', error);
            this.showNotification('error', 'İkon ayarları sıfırlanamadı', 'error');
        }
    }

    updateIconColor(inputId, value) {
        console.log('updateIconColor called:', inputId, value);
        
        this.isRealTimeUpdate = true;
        
        const cssVarMap = {
            'bubbleHomeIconColor': '--bubble-home-icon-color',
            'bubbleHomeIconBg': '--bubble-home-icon-bg',
            'bubbleHomeIconHoverColor': '--bubble-home-icon-hover-color',
            'bubbleHomeIconHoverBg': '--bubble-home-icon-hover-bg',
            'bubbleRepairFixIconColor': '--bubble-repairfix-icon-color',
            'bubbleRepairFixIconBg': '--bubble-repairfix-icon-bg',
            'bubbleRepairFixIconHoverColor': '--bubble-repairfix-icon-hover-color',
            'bubbleRepairFixIconHoverBg': '--bubble-repairfix-icon-hover-bg',
            'bubbleBypassIconColor': '--bubble-bypass-icon-color',
            'bubbleBypassIconBg': '--bubble-bypass-icon-bg',
            'bubbleBypassIconHoverColor': '--bubble-bypass-icon-hover-color',
            'bubbleBypassIconHoverBg': '--bubble-bypass-icon-hover-bg',
            'bubbleLibraryIconColor': '--bubble-library-icon-color',
            'bubbleLibraryIconBg': '--bubble-library-icon-bg',
            'bubbleLibraryIconHoverColor': '--bubble-library-icon-hover-color',
            'bubbleLibraryIconHoverBg': '--bubble-library-icon-hover-bg',
            'bubbleManualInstallIconColor': '--bubble-manualinstall-icon-color',
            'bubbleManualInstallIconBg': '--bubble-manualinstall-icon-bg',
            'bubbleManualInstallIconHoverColor': '--bubble-manualinstall-icon-hover-color',
            'bubbleManualInstallIconHoverBg': '--bubble-manualinstall-icon-hover-bg',
            'bubbleSettingsIconColor': '--bubble-settings-icon-color',
            'bubbleSettingsIconBg': '--bubble-settings-icon-bg',
            'bubbleSettingsIconHoverColor': '--bubble-settings-icon-hover-color',
            'bubbleSettingsIconHoverBg': '--bubble-settings-icon-hover-bg',
            'hamburgerColor': '--hamburger-color',
            'hamburgerBg': '--hamburger-bg',
            'hamburgerHoverColor': '--hamburger-hover-color',
            'hamburgerHoverBg': '--hamburger-hover-bg'
        };

        const cssVar = cssVarMap[inputId];
        if (cssVar) {
            document.documentElement.style.setProperty(cssVar, value);
            
            this.updateIconPreview(inputId, value);
            
            this.updateRealIcons(inputId, value);
            
            if (inputId.includes('HoverBg')) {
                this.forceHoverUpdate(inputId, value);
            }
            
            if (inputId.includes('Glow')) {
                this.forceGlowUpdate(inputId, value);
            }
            
            setTimeout(() => {
                this.isRealTimeUpdate = false;
            }, 100);
        }
    }

    forceHoverUpdate(inputId, value) {
        const iconMap = {
            'bubbleHomeIconHoverBg': '#bubbleHome',
            'bubbleRepairFixIconHoverBg': '#bubbleRepairFix',
            'bubbleBypassIconHoverBg': '#bubbleBypass',
            'bubbleLibraryIconHoverBg': '#bubbleLibrary',
            'bubbleManualInstallIconHoverBg': '#bubbleManualInstall',
            'bubbleSettingsIconHoverBg': '#bubbleSettings'
        };
        
        const iconId = iconMap[inputId];
        if (iconId) {
            const icon = document.querySelector(iconId);
            if (icon) {
                icon.style.display = 'none';
                icon.offsetHeight; // Force reflow
                icon.style.display = '';
                
                icon.style.setProperty('--bubble-hover-bg', value);
            }
        }
    }

    forceGlowUpdate(inputId, value) {
        const iconMap = {
            'bubbleHomeIconGlow': '#bubbleHome',
            'bubbleRepairFixIconGlow': '#bubbleRepairFix',
            'bubbleBypassIconGlow': '#bubbleBypass',
            'bubbleLibraryIconGlow': '#bubbleLibrary',
            'bubbleManualInstallIconGlow': '#bubbleManualInstall',
            'bubbleSettingsIconGlow': '#bubbleSettings'
        };
        
        const iconId = iconMap[inputId];
        if (iconId) {
            const icon = document.querySelector(iconId);
            if (icon) {
                icon.style.display = 'none';
                icon.offsetHeight; // Force reflow
                icon.style.display = '';
                
                icon.style.setProperty('--bubble-glow', value);
            }
        }
    }

    updateRealIcons(inputId, value) {
        const iconMap = {
            'bubbleHomeIconColor': '#bubbleHome',
            'bubbleHomeIconBg': '#bubbleHome',
            'bubbleHomeIconHoverColor': '#bubbleHome',
            'bubbleHomeIconHoverBg': '#bubbleHome',
            'bubbleRepairFixIconColor': '#bubbleRepairFix',
            'bubbleRepairFixIconBg': '#bubbleRepairFix',
            'bubbleRepairFixIconHoverColor': '#bubbleRepairFix',
            'bubbleRepairFixIconHoverBg': '#bubbleRepairFix',
            'bubbleBypassIconColor': '#bubbleBypass',
            'bubbleBypassIconBg': '#bubbleBypass',
            'bubbleBypassIconHoverColor': '#bubbleBypass',
            'bubbleBypassIconHoverBg': '#bubbleBypass',
            'bubbleLibraryIconColor': '#bubbleLibrary',
            'bubbleLibraryIconBg': '#bubbleLibrary',
            'bubbleLibraryIconHoverColor': '#bubbleLibrary',
            'bubbleLibraryIconHoverBg': '#bubbleLibrary',
            'bubbleManualInstallIconColor': '#bubbleManualInstall',
            'bubbleManualInstallIconBg': '#bubbleManualInstall',
            'bubbleManualInstallIconHoverColor': '#bubbleManualInstall',
            'bubbleManualInstallIconHoverBg': '#bubbleManualInstall',
            'bubbleSettingsIconColor': '#bubbleSettings',
            'bubbleSettingsIconBg': '#bubbleSettings',
            'bubbleSettingsIconHoverColor': '#bubbleSettings',
            'bubbleSettingsIconHoverBg': '#bubbleSettings',
            'hamburgerColor': '#hamburgerMenuBtn',
            'hamburgerBg': '#hamburgerMenuBtn',
            'hamburgerHoverColor': '#hamburgerMenuBtn',
            'hamburgerHoverBg': '#hamburgerMenuBtn'
        };

        const iconId = iconMap[inputId];
        if (iconId) {
            const icon = document.querySelector(iconId);
            if (icon) {
                if (inputId.includes('Color') && !inputId.includes('Hover')) {
                    icon.style.color = value;
                } else if (inputId.includes('Bg') && !inputId.includes('Hover')) {
                    icon.style.backgroundColor = value;
                } else if (inputId.includes('HoverColor')) {
                    const style = document.createElement('style');
                    style.id = `hover-style-${inputId}`;
                    style.textContent = `${iconId}:hover { color: ${value} !important; }`;
                    document.head.appendChild(style);
                } else if (inputId.includes('HoverBg')) {
                    const style = document.createElement('style');
                    style.id = `hover-style-${inputId}`;
                    style.textContent = `${iconId}:hover { background: ${value} !important; }`;
                    document.head.appendChild(style);
                }
            }
        }
        
        if (inputId.includes('HoverBg')) {
            this.refreshHoverStyles();
        }
    }

    refreshHoverStyles() {
        const existingStyles = document.querySelectorAll('style[id^="hover-style-"]');
        existingStyles.forEach(style => style.remove());
        
        const existingGlowStyles = document.querySelectorAll('style[id^="glow-style-"]');
        existingGlowStyles.forEach(style => style.remove());
        
        const hoverBgInputs = [
            'bubbleHomeIconHoverBg',
            'bubbleRepairFixIconHoverBg',
            'bubbleBypassIconHoverBg',
            'bubbleLibraryIconHoverBg',
            'bubbleManualInstallIconHoverBg',
            'bubbleSettingsIconHoverBg'
        ];
        
        const glowInputs = [
            'bubbleHomeIconGlow',
            'bubbleRepairFixIconGlow',
            'bubbleBypassIconGlow',
            'bubbleLibraryIconGlow',
            'bubbleManualInstallIconGlow',
            'bubbleSettingsIconGlow'
        ];
        
        hoverBgInputs.forEach(inputId => {
            const input = document.getElementById(inputId);
            if (input && input.value) {
                const iconMap = {
                    'bubbleHomeIconHoverBg': '#bubbleHome',
                    'bubbleRepairFixIconHoverBg': '#bubbleRepairFix',
                    'bubbleBypassIconHoverBg': '#bubbleBypass',
                    'bubbleLibraryIconHoverBg': '#bubbleLibrary',
                    'bubbleManualInstallIconHoverBg': '#bubbleManualInstall',
                    'bubbleSettingsIconHoverBg': '#bubbleSettings'
                };
                
                const iconId = iconMap[inputId];
                if (iconId) {
                    const style = document.createElement('style');
                    style.id = `hover-style-${inputId}`;
                    style.textContent = `${iconId}:hover { background: ${input.value} !important; }`;
                    document.head.appendChild(style);
                    
                    const icon = document.querySelector(iconId);
                    if (icon) {
                        icon.style.display = 'none';
                        icon.offsetHeight; // Force reflow
                        icon.style.display = '';
                    }
                }
            }
        });
        
        glowInputs.forEach(inputId => {
            const input = document.getElementById(inputId);
            if (input && input.value) {
                const iconMap = {
                    'bubbleHomeIconGlow': '#bubbleHome',
                    'bubbleRepairFixIconGlow': '#bubbleRepairFix',
                    'bubbleLibraryIconGlow': '#bubbleLibrary',
                    'bubbleManualInstallIconGlow': '#bubbleManualInstall',
                    'bubbleSettingsIconGlow': '#bubbleSettings'
                };
                
                const iconId = iconMap[inputId];
                if (iconId) {
                    const style = document.createElement('style');
                    style.id = `glow-style-${inputId}`;
                    style.textContent = `${iconId}:hover { box-shadow: 0 8px 25px ${input.value}, 0 0 20px ${input.value} !important; }`;
                    document.head.appendChild(style);
                    
                    const icon = document.querySelector(iconId);
                    if (icon) {
                        icon.style.display = 'none';
                        icon.offsetHeight; // Force reflow
                        icon.style.display = '';
                    }
                }
            }
        });
        
        const allBubbleIcons = ['#bubbleHome', '#bubbleRepairFix', '#bubbleBypass', '#bubbleLibrary', '#bubbleManualInstall', '#bubbleSettings'];
        allBubbleIcons.forEach(iconId => {
            const icon = document.querySelector(iconId);
            if (icon) {
                icon.style.display = 'none';
                icon.offsetHeight; // Force reflow
                icon.style.display = '';
            }
        });
    }

    updateIconRange(inputId, value) {
        this.isRealTimeUpdate = true;
        
        const cssVarMap = {
            'hamburgerLineWeight': '--hamburger-line-weight',
            'hamburgerLineGap': '--hamburger-line-gap'
        };

        const cssVar = cssVarMap[inputId];
        if (cssVar) {
            document.documentElement.style.setProperty(cssVar, value + 'px');
            this.updateRangeDisplay(inputId, value);
            this.updateIconPreview(inputId, value);
            
            setTimeout(() => {
                this.isRealTimeUpdate = false;
            }, 100);
        }
    }

    updateRangeDisplay(inputId, value) {
        const displayElement = document.querySelector(`#${inputId} + .range-value`);
        if (displayElement) {
            displayElement.textContent = value + 'px';
        }
    }

    updateIconPreview(inputId, value) {
        const previewElements = document.querySelectorAll('.preview-icon, .preview-bubble-item, .hamburger-line');
        previewElements.forEach(element => {
            const computedStyle = getComputedStyle(document.documentElement);
            
            const colorVars = [
                '--title-minimize-icon-color', '--title-maximize-icon-color', '--title-close-icon-color',
                '--bubble-home-icon-color', '--bubble-repairfix-icon-color', '--bubble-bypass-icon-color', '--bubble-library-icon-color',
                '--bubble-manualinstall-icon-color', '--bubble-settings-icon-color',
                '--bubble-home-icon-hover-color', '--bubble-repairfix-icon-hover-color', '--bubble-bypass-icon-hover-color', '--bubble-library-icon-hover-color',
                '--bubble-manualinstall-icon-hover-color', '--bubble-settings-icon-hover-color',
                '--bubble-home-icon-glow', '--bubble-repairfix-icon-glow', '--bubble-bypass-icon-glow', '--bubble-library-icon-glow',
                '--bubble-manualinstall-icon-glow', '--bubble-settings-icon-glow',
                '--hamburger-color', '--hamburger-hover-color'
            ];

            const bgVars = [
                '--bubble-home-icon-bg', '--bubble-repairfix-icon-bg', '--bubble-bypass-icon-bg', '--bubble-library-icon-bg',
                '--bubble-manualinstall-icon-bg', '--bubble-settings-icon-bg',
                '--bubble-home-icon-hover-bg', '--bubble-repairfix-icon-hover-bg', '--bubble-bypass-icon-hover-bg', '--bubble-library-icon-hover-bg',
                '--bubble-manualinstall-icon-hover-bg', '--bubble-settings-icon-hover-bg',
                '--bubble-home-icon-glow', '--bubble-repairfix-icon-glow', '--bubble-bypass-icon-glow', '--bubble-library-icon-glow',
                '--bubble-manualinstall-icon-glow', '--bubble-settings-icon-glow',
                '--hamburger-bg', '--hamburger-hover-bg'
            ];

            colorVars.forEach(varName => {
                const value = computedStyle.getPropertyValue(varName);
                if (value) {
                    element.style.color = value;
                }
            });

            bgVars.forEach(varName => {
                const value = computedStyle.getPropertyValue(varName);
                if (value && value !== 'transparent') {
                    element.style.backgroundColor = value;
                }
            });
        });
    }



    saveIconSettings() {
        const iconSettings = {};
        const inputs = document.querySelectorAll('#iconDesigner input[type="color"], #iconDesigner input[type="range"]');
        
        inputs.forEach(input => {
            if (input.type === 'color') {
                iconSettings[input.id] = input.value;
            } else if (input.type === 'range') {
                iconSettings[input.id] = input.value + 'px';
            }
        });

        this.config.iconSettings = iconSettings;
        this.updateConfig({ iconSettings: iconSettings });
        
        Object.entries(iconSettings).forEach(([inputId, value]) => {
            if (inputId.includes('Color') || inputId.includes('Bg')) {
                this.updateIconColor(inputId, value);
            } else if (inputId.includes('Weight') || inputId.includes('Gap')) {
                this.updateIconRange(inputId, value.replace('px', ''));
            }
        });
        
        this.refreshHoverStyles();
        
        this.isRealTimeUpdate = false;
        this.showSaveSuccess();
    }

    showResetSuccess() {
        if (this.isRealTimeUpdate) return;
        
        const existingNotifications = document.querySelectorAll('.icon-notification');
        existingNotifications.forEach(notification => notification.remove());

        const message = document.createElement('div');
        message.className = 'icon-notification';
        message.style.cssText = `
            position: fixed;
            top: 20px;
            right: 20px;
            background: linear-gradient(135deg, #ff4757, #ff3742);
            color: white;
            padding: 16px 24px;
            border-radius: 12px;
            font-weight: 600;
            z-index: 1000;
            box-shadow: 0 8px 25px rgba(255, 71, 87, 0.3);
            backdrop-filter: blur(10px);
            border: 1px solid rgba(255, 71, 87, 0.2);
            transform: translateX(100%);
            transition: transform 0.3s ease;
            font-size: 14px;
        `;
        message.innerHTML = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/>
                    <path d="M3 3v5h5"/>
                </svg>
                İkon ayarları sıfırlandı!
            </div>
        `;
        document.body.appendChild(message);
        
        setTimeout(() => {
            message.style.transform = 'translateX(0)';
        }, 100);
        
        setTimeout(() => {
            message.style.transform = 'translateX(100%)';
            setTimeout(() => {
                if (message.parentNode) {
                    message.remove();
                }
            }, 300);
        }, 3000);
    }

    highlightSelectedIcon(iconId, iconType) {
        document.querySelectorAll('.icon-sample').forEach(sample => {
            sample.style.border = '2px solid transparent';
            sample.style.boxShadow = 'none';
        });
        
        if (iconType === 'hamburger') {
            const hamburgerPreview = document.getElementById('hamburgerPreview');
            if (hamburgerPreview) {
                hamburgerPreview.style.border = '2px solid var(--accent-primary)';
                hamburgerPreview.style.boxShadow = '0 0 20px var(--accent-primary)';
            }
        } else if (iconType === 'title') {
            const titlePreview = document.getElementById('titlePreview');
            if (titlePreview) {
                titlePreview.style.border = '2px solid var(--accent-primary)';
                titlePreview.style.boxShadow = '0 0 20px var(--accent-primary)';
            }
        }
    }

    showCustomizationInfo(iconId, iconType) {
        const iconNames = {
            'hamburger': 'Hamburger Menü',
            'minimize': 'Minimize',
            'maximize': 'Maximize',
            'close': 'Kapat',
            'home': 'Ana Sayfa',
            'settings': 'Ayarlar',
            'download': 'İndir'
        };
        const iconName = iconNames[iconId] || iconId;
        
        const infoMsg = document.createElement('div');
        infoMsg.style.cssText = `
            position: fixed;
            top: 80px;
            right: 20px;
            background: var(--accent-primary);
            color: var(--primary-bg);
            padding: 12px 20px;
            border-radius: 8px;
            font-weight: 600;
            z-index: 1000;
            box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
            max-width: 250px;
        `;
        infoMsg.innerHTML = `🎨 <strong>${iconName}</strong> ikonunu özelleştiriyorsun!<br><small>Renkleri ve arka planları değiştir</small>`;
        document.body.appendChild(infoMsg);
        
        setTimeout(() => {
            if (infoMsg.parentNode) {
                infoMsg.parentNode.removeChild(infoMsg);
            }
        }, 5000);
    }

    showNoIconSelectedMessage() {
        const msg = document.createElement('div');
        msg.style.cssText = `
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: var(--warning);
            color: white;
            padding: 20px 30px;
            border-radius: 12px;
            font-weight: 600;
            z-index: 1000;
            text-align: center;
            box-shadow: 0 8px 25px rgba(0, 0, 0, 0.3);
        `;
        msg.innerHTML = `⚠️ Henüz ikon seçilmedi!<br><br><small>Önce "İkon Seçici" ile bir ikon seç</small>`;
        document.body.appendChild(msg);
        
        setTimeout(() => {
            if (msg.parentNode) {
                msg.parentNode.removeChild(msg);
            }
        }, 4000);
    }

    loadSelectedIconOnStartup() {
        if (this.config.selectedIcon) {
            const { id, type } = this.config.selectedIcon;
            this.updateSelectedIconIndicator(id, type);
        }
    }

    setupIconDesigner() {
        document.querySelectorAll('#iconDesigner input[type="color"]').forEach(inp => {
            inp.addEventListener('change', (e) => {
                const id = e.target.id;
                const value = e.target.value;
                this.updateIconColor(id, value);
            });
        });

        document.querySelectorAll('#iconDesigner input[type="range"]').forEach(inp => {
            inp.addEventListener('input', (e) => {
                const id = e.target.id;
                const value = e.target.value;
                this.updateIconRange(id, value);
            });
        });

        this.setupBubbleIconListeners();
    }

    setupBubbleIconListeners() {
        const bubbleIcons = [
                            'home', 'repairFix', 'bypass', 'library', 'manualInstall', 'settings'
        ];

        bubbleIcons.forEach(iconType => {
            const colorInput = document.getElementById(`bubble${iconType.charAt(0).toUpperCase() + iconType.slice(1)}IconColor`);
            if (colorInput) {
                colorInput.addEventListener('change', (e) => {
                    this.updateBubbleIconColor(iconType, 'color', e.target.value);
                });
            }

            const bgInput = document.getElementById(`bubble${iconType.charAt(0).toUpperCase() + iconType.slice(1)}IconBg`);
            if (bgInput) {
                bgInput.addEventListener('change', (e) => {
                    this.updateBubbleIconColor(iconType, 'bg', e.target.value);
                });
            }

            const hoverColorInput = document.getElementById(`bubble${iconType.charAt(0).toUpperCase() + iconType.slice(1)}IconHoverColor`);
            if (hoverColorInput) {
                hoverColorInput.addEventListener('change', (e) => {
                    this.updateBubbleIconColor(iconType, 'hoverColor', e.target.value);
                });
            }

            const hoverBgInput = document.getElementById(`bubble${iconType.charAt(0).toUpperCase() + iconType.slice(1)}IconHoverBg`);
            if (hoverBgInput) {
                hoverBgInput.addEventListener('change', (e) => {
                    this.updateBubbleIconColor(iconType, 'hoverBg', e.target.value);
                });
            }

            const glowInput = document.getElementById(`bubble${iconType.charAt(0).toUpperCase() + iconType.slice(1)}IconGlow`);
            if (glowInput) {
                glowInput.addEventListener('change', (e) => {
                    this.updateBubbleIconColor(iconType, 'glow', e.target.value);
                });
            }
        });
    }

    updateBubbleIconColor(iconType, property, value) {
        const theme = this.getCurrentTheme();
        const cssVar = `--bubble-${iconType.toLowerCase()}-icon-${property}`;
        
        theme[cssVar] = value;
        document.documentElement.style.setProperty(cssVar, value);
        
        if (iconType === 'bypass') {
            if (property === 'hoverBg') {
                document.documentElement.style.setProperty('--bubble-bypass-icon-hover-bg', value);
            } else if (property === 'glow') {
                document.documentElement.style.setProperty('--bubble-bypass-icon-glow', value);
            }
        }
        
        this.updateBubbleIconPreview(iconType, property, value);
        
        this.saveCurrentTheme();
    }

    updateBubbleIconPreview(iconType, property, value) {
        const previewIcon = document.querySelector(`[data-icon="${iconType}"]`);
        const liveIcon = document.querySelector(`.live-bubble-item[data-icon="${iconType}"]`);
        
        if (previewIcon) {
            if (property === 'color') {
                previewIcon.style.color = value;
            } else if (property === 'bg') {
                previewIcon.style.background = value;
            }
        }
        
        if (liveIcon) {
            if (property === 'color') {
                liveIcon.style.color = value;
            } else if (property === 'bg') {
                liveIcon.style.background = value;
            }
        }
    }

    updateIconColor(id, value) {
        const theme = this.getCurrentTheme();
        
        const colorMap = {
            'titleIconColor': '--title-icon-color',
            'titleIconBg': '--title-icon-bg',
            'titleIconHoverColor': '--title-icon-hover-color',
            'titleIconHoverBg': '--title-icon-hover-bg',
            'bubbleIconColor': '--bubble-icon-color',
            'bubbleIconBg': '--bubble-icon-bg',
            'bubbleIconHoverColor': '--bubble-icon-hover-color',
            'bubbleIconHoverBg': '--bubble-icon-hover-bg',
            'hamburgerColor': '--hamburger-color',
            'hamburgerHoverColor': '--hamburger-hover-color'
        };

        const cssVar = colorMap[id];
        if (cssVar) {
            theme[cssVar] = value;
            document.documentElement.style.setProperty(cssVar, value);
            this.updateIconPreview();
        }
    }

    updateIconRange(id, value) {
        const theme = this.getCurrentTheme();
        
        const rangeMap = {
            'titleIconSize': '--title-icon-size',
            'titleIconWeight': '--title-icon-weight',
            'bubbleIconSize': '--bubble-icon-size',
            'bubbleIconWeight': '--bubble-icon-weight',
            'bubbleIconRadius': '--bubble-icon-radius',
            'hamburgerLineWeight': '--hamburger-line-weight',
            'hamburgerLineGap': '--hamburger-line-gap'
        };

        const cssVar = rangeMap[id];
        if (cssVar) {
            theme[cssVar] = value;
            document.documentElement.style.setProperty(cssVar, value);
            
            const displayElement = document.querySelector(`#${id}`).nextElementSibling;
            if (displayElement) {
                displayElement.textContent = value + (id.includes('Size') || id.includes('Radius') || id.includes('Gap') ? 'px' : 'px');
            }
            
            this.updateIconPreview();
        }
    }

    updateIconPreview() {
        const theme = this.getCurrentTheme();
        
        const titleIcons = document.querySelectorAll('.preview-icon, .live-icon');
        titleIcons.forEach(icon => {
            icon.style.color = theme['--title-icon-color'] || '#a1a1aa';
            icon.style.background = theme['--title-icon-bg'] || '#000000';
            icon.style.fontSize = (theme['--title-icon-size'] || '12') + 'px';
            icon.style.fontWeight = theme['--title-icon-weight'] || '1.5';
        });

        const bubbleIcons = document.querySelectorAll('.preview-bubble-item, .live-bubble-item');
        bubbleIcons.forEach(icon => {
            icon.style.color = theme['--bubble-icon-color'] || '#a1a1aa';
            icon.style.background = theme['--bubble-icon-bg'] || '#1a1a1a';
            icon.style.fontSize = (theme['--bubble-icon-size'] || '20') + 'px';
            icon.style.fontWeight = theme['--bubble-icon-weight'] || '2';
            icon.style.borderRadius = (theme['--bubble-icon-radius'] || '8') + 'px';
        });

        const hamburgerLines = document.querySelectorAll('.hamburger-line, .live-hamburger-line');
        hamburgerLines.forEach(line => {
            line.style.background = theme['--hamburger-color'] || '#a1a1aa';
            line.style.height = (theme['--hamburger-line-weight'] || '2') + 'px';
        });

        const hamburgerMenus = document.querySelectorAll('.preview-hamburger, .live-hamburger');
        hamburgerMenus.forEach(menu => {
            menu.style.gap = (theme['--hamburger-line-gap'] || '3') + 'px';
        });

        this.saveCurrentTheme();
    }





    getCurrentTheme() {
        const theme = (this.config && this.config.customTheme) ? this.config.customTheme : {};
        return theme || {};
    }
    
    getThemeColors(theme) {
        const colors = {
            'modern-blue': {
                background: 'linear-gradient(135deg, rgba(0, 212, 255, 0.1) 0%, rgba(59, 130, 246, 0.1) 100%)',
                border: 'rgba(0, 212, 255, 0.3)',
                shadow: 'rgba(0, 212, 255, 0.2)',
                textPrimary: '#ffffff',
                textSecondary: 'rgba(255, 255, 255, 0.8)',
                textShadow: 'rgba(0, 0, 0, 0.3)',
                accent: '#00d4ff',
                accentShadow: 'rgba(0, 212, 255, 0.5)',
                iconGradient: 'linear-gradient(135deg, #00d4ff, #3b82f6)',
                iconGlow: 'rgba(0, 212, 255, 0.6)',
                progressBg: 'rgba(255, 255, 255, 0.15)',
                progressFill: 'linear-gradient(90deg, #00d4ff, #3b82f6)',
                
                primaryBg: '#0f0f0f',
                secondaryBg: '#1a1a1a',
                tertiaryBg: '#252525',
                cardBg: 'rgba(26, 26, 26, 0.95)',
                cardHover: 'rgba(0, 212, 255, 0.15)',
                buttonBg: '#00d4ff',
                buttonHover: '#3b82f6',
                buttonText: '#ffffff',
                inputBg: 'rgba(26, 26, 26, 0.8)',
                inputBorder: 'rgba(0, 212, 255, 0.3)',
                inputFocus: 'rgba(0, 212, 255, 0.5)',
                sidebarBg: 'rgba(15, 15, 15, 0.95)',
                sidebarHover: 'rgba(0, 212, 255, 0.1)',
                titleBarBg: 'rgba(15, 15, 15, 0.98)',
                topNavBg: 'rgba(26, 26, 26, 0.95)',
                footerBg: 'rgba(15, 15, 15, 0.95)',
                modalBg: 'rgba(15, 15, 15, 0.98)',
                modalOverlay: 'rgba(0, 0, 0, 0.7)',
                notificationBg: 'rgba(26, 26, 26, 0.95)',
                notificationSuccess: '#22c55e',
                notificationError: '#ef4444',
                notificationWarning: '#f59e0b',
                notificationInfo: '#00d4ff'
            },
            'neon-green': {
                background: 'linear-gradient(135deg, rgba(34, 197, 94, 0.1) 0%, rgba(16, 185, 129, 0.1) 100%)',
                border: 'rgba(34, 197, 94, 0.3)',
                shadow: 'rgba(34, 197, 94, 0.2)',
                textPrimary: '#ffffff',
                textSecondary: 'rgba(255, 255, 255, 0.8)',
                textShadow: 'rgba(0, 0, 0, 0.3)',
                accent: '#22c55e',
                accentShadow: 'rgba(34, 197, 94, 0.5)',
                iconGradient: 'linear-gradient(135deg, #22c55e, #10b981)',
                iconGlow: 'rgba(34, 197, 94, 0.6)',
                progressBg: 'rgba(255, 255, 255, 0.15)',
                progressFill: 'linear-gradient(90deg, #22c55e, #10b981)',
                
                primaryBg: '#0a1a0a',
                secondaryBg: '#0f1f0f',
                tertiaryBg: '#142514',
                cardBg: 'rgba(15, 31, 15, 0.95)',
                cardHover: 'rgba(34, 197, 94, 0.15)',
                buttonBg: '#22c55e',
                buttonHover: '#16a34a',
                buttonText: '#ffffff',
                inputBg: 'rgba(15, 31, 15, 0.8)',
                inputBorder: 'rgba(34, 197, 94, 0.3)',
                inputFocus: 'rgba(34, 197, 94, 0.5)',
                sidebarBg: 'rgba(10, 26, 10, 0.95)',
                sidebarHover: 'rgba(34, 197, 94, 0.1)',
                titleBarBg: 'rgba(10, 26, 10, 0.98)',
                topNavBg: 'rgba(15, 31, 15, 0.95)',
                footerBg: 'rgba(10, 26, 10, 0.95)',
                modalBg: 'rgba(10, 26, 10, 0.98)',
                modalOverlay: 'rgba(0, 0, 0, 0.7)',
                notificationBg: 'rgba(15, 31, 15, 0.95)',
                notificationSuccess: '#22c55e',
                notificationError: '#ef4444',
                notificationWarning: '#f59e0b',
                notificationInfo: '#22c55e'
            },
            'glass-purple': {
                background: 'linear-gradient(135deg, rgba(139, 92, 246, 0.1) 0%, rgba(168, 85, 247, 0.1) 100%)',
                border: 'rgba(139, 92, 246, 0.3)',
                shadow: 'rgba(139, 92, 246, 0.2)',
                textPrimary: '#ffffff',
                textSecondary: 'rgba(255, 255, 255, 0.8)',
                textShadow: 'rgba(0, 0, 0, 0.3)',
                accent: '#8b5cf6',
                accentShadow: 'rgba(139, 92, 246, 0.5)',
                iconGradient: 'linear-gradient(135deg, #8b5cf6, #a855f7)',
                iconGlow: 'rgba(139, 92, 246, 0.6)',
                progressBg: 'rgba(255, 255, 255, 0.15)',
                progressFill: 'linear-gradient(90deg, #8b5cf6, #a855f7)',
                
                primaryBg: '#1a0a2e',
                secondaryBg: '#1f0f3a',
                tertiaryBg: '#241446',
                cardBg: 'rgba(31, 15, 58, 0.95)',
                cardHover: 'rgba(139, 92, 246, 0.15)',
                buttonBg: '#8b5cf6',
                buttonHover: '#7c3aed',
                buttonText: '#ffffff',
                inputBg: 'rgba(31, 15, 58, 0.8)',
                inputBorder: 'rgba(139, 92, 246, 0.3)',
                inputFocus: 'rgba(139, 92, 246, 0.5)',
                sidebarBg: 'rgba(26, 10, 46, 0.95)',
                sidebarHover: 'rgba(139, 92, 246, 0.1)',
                titleBarBg: 'rgba(26, 10, 46, 0.98)',
                topNavBg: 'rgba(31, 15, 58, 0.95)',
                footerBg: 'rgba(26, 10, 46, 0.95)',
                modalBg: 'rgba(26, 10, 46, 0.98)',
                modalOverlay: 'rgba(0, 0, 0, 0.7)',
                notificationBg: 'rgba(31, 15, 58, 0.95)',
                notificationSuccess: '#22c55e',
                notificationError: '#ef4444',
                notificationWarning: '#f59e0b',
                notificationInfo: '#8b5cf6'
            },
            'minimal-dark': {
                background: 'linear-gradient(135deg, rgba(31, 41, 55, 0.95) 0%, rgba(17, 24, 39, 0.95) 100%)',
                border: 'rgba(75, 85, 99, 0.3)',
                shadow: 'rgba(0, 0, 0, 0.4)',
                textPrimary: '#ffffff',
                textSecondary: 'rgba(255, 255, 255, 0.7)',
                textShadow: 'rgba(0, 0, 0, 0.5)',
                accent: '#60a5fa',
                accentShadow: 'rgba(96, 165, 250, 0.5)',
                iconGradient: 'linear-gradient(135deg, #60a5fa, #3b82f6)',
                iconGlow: 'rgba(96, 165, 250, 0.6)',
                progressBg: 'rgba(255, 255, 255, 0.1)',
                progressFill: 'linear-gradient(90deg, #60a5fa, #3b82f6)',
                
                primaryBg: '#111827',
                secondaryBg: '#1f2937',
                tertiaryBg: '#374151',
                cardBg: 'rgba(31, 41, 55, 0.95)',
                cardHover: 'rgba(96, 165, 250, 0.15)',
                buttonBg: '#60a5fa',
                buttonHover: '#3b82f6',
                buttonText: '#ffffff',
                inputBg: 'rgba(31, 41, 55, 0.8)',
                inputBorder: 'rgba(75, 85, 99, 0.3)',
                inputFocus: 'rgba(96, 165, 250, 0.5)',
                sidebarBg: 'rgba(17, 24, 39, 0.95)',
                sidebarHover: 'rgba(96, 165, 250, 0.1)',
                titleBarBg: 'rgba(17, 24, 39, 0.98)',
                topNavBg: 'rgba(31, 41, 55, 0.95)',
                footerBg: 'rgba(17, 24, 39, 0.95)',
                modalBg: 'rgba(17, 24, 39, 0.98)',
                modalOverlay: 'rgba(0, 0, 0, 0.7)',
                notificationBg: 'rgba(31, 41, 55, 0.95)',
                notificationSuccess: '#22c55e',
                notificationError: '#ef4444',
                notificationWarning: '#f59e0b',
                notificationInfo: '#60a5fa'
            },
            'retro-orange': {
                background: 'linear-gradient(135deg, rgba(251, 146, 60, 0.1) 0%, rgba(245, 101, 101, 0.1) 100%)',
                border: 'rgba(251, 146, 60, 0.3)',
                shadow: 'rgba(251, 146, 60, 0.2)',
                textPrimary: '#ffffff',
                textSecondary: 'rgba(255, 255, 255, 0.8)',
                textShadow: 'rgba(0, 0, 0, 0.3)',
                accent: '#fb923c',
                accentShadow: 'rgba(251, 146, 60, 0.5)',
                iconGradient: 'linear-gradient(135deg, #fb923c, #f56565)',
                iconGlow: 'rgba(251, 146, 60, 0.6)',
                progressBg: 'rgba(255, 255, 255, 0.15)',
                progressFill: 'linear-gradient(90deg, #fb923c, #f56565)',
                
                primaryBg: '#2d1b0a',
                secondaryBg: '#3d2510',
                tertiaryBg: '#4d2f16',
                cardBg: 'rgba(61, 37, 16, 0.95)',
                cardHover: 'rgba(251, 146, 60, 0.15)',
                buttonBg: '#fb923c',
                buttonHover: '#ea580c',
                buttonText: '#ffffff',
                inputBg: 'rgba(61, 37, 16, 0.8)',
                inputBorder: 'rgba(251, 146, 60, 0.3)',
                inputFocus: 'rgba(251, 146, 60, 0.5)',
                sidebarBg: 'rgba(45, 27, 10, 0.95)',
                sidebarHover: 'rgba(251, 146, 60, 0.1)',
                titleBarBg: 'rgba(45, 27, 10, 0.98)',
                topNavBg: 'rgba(61, 37, 16, 0.95)',
                footerBg: 'rgba(45, 27, 10, 0.95)',
                modalBg: 'rgba(45, 27, 10, 0.98)',
                modalOverlay: 'rgba(0, 0, 0, 0.7)',
                notificationBg: 'rgba(61, 37, 16, 0.95)',
                notificationSuccess: '#22c55e',
                notificationError: '#ef4444',
                notificationWarning: '#f59e0b',
                notificationInfo: '#fb923c'
            }
        };
        
        const themeName = theme.themePreset ? theme.themePreset.toLowerCase().replace(/\s+/g, '-') : 'modern-blue';
        return colors[themeName] || colors['modern-blue'];
    }

    toHexColor(val) {
        if (!val) return '#000000';
        const s = val.toString().trim();
        if (s.startsWith('#') && (s.length === 7 || s.length === 4)) return s.length === 4 ? this.shorthandToFullHex(s) : s;
        if (s.startsWith('rgb')) {
            const m = s.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
            if (m) {
                const r = Number(m[1]).toString(16).padStart(2, '0');
                const g = Number(m[2]).toString(16).padStart(2, '0');
                const b = Number(m[3]).toString(16).padStart(2, '0');
                return `#${r}${g}${b}`;
            }
        }
        return '#000000';
    }

    shorthandToFullHex(h) {
        return '#' + h.slice(1).split('').map(c => c + c).join('');
    }

    applyThemeFromConfig() {
        const theme = this.getCurrentTheme();
        const themeColors = this.getThemeColors(theme);
        
        const cssVars = {
            '--primary-bg': themeColors.primaryBg,
            '--secondary-bg': themeColors.secondaryBg,
            '--tertiary-bg': themeColors.tertiaryBg,
            '--card-bg': themeColors.cardBg,
            '--card-hover': themeColors.cardHover,
            '--button-bg': themeColors.buttonBg,
            '--button-hover': themeColors.buttonHover,
            '--button-text': themeColors.buttonText,
            '--input-bg': themeColors.inputBg,
            '--input-border': themeColors.inputBorder,
            '--input-focus': themeColors.inputFocus,
            '--sidebar-bg': themeColors.sidebarBg,
            '--sidebar-hover': themeColors.sidebarHover,
            '--title-bar-bg': themeColors.titleBarBg,
            '--top-nav-bg': themeColors.topNavBg,
            '--footer-bg': themeColors.footerBg,
            '--modal-bg': themeColors.modalBg,
            '--modal-overlay': themeColors.modalOverlay,
            '--notification-bg': themeColors.notificationBg,
            '--notification-success': themeColors.notificationSuccess,
            '--notification-error': themeColors.notificationError,
            '--notification-warning': themeColors.notificationWarning,
            '--notification-info': themeColors.notificationInfo,
            '--accent-color': themeColors.accent,
            '--text-primary': themeColors.textPrimary,
            '--text-secondary': themeColors.textSecondary
        };
        
        for (const [key, value] of Object.entries(cssVars)) {
            document.documentElement.style.setProperty(key, value);
        }
        
        for (const [k, v] of Object.entries(theme)) {
            document.documentElement.style.setProperty(k, v);
        }
        
        console.log('🎨 Tema uygulandı:', theme.themePreset || 'modern-blue');
    }

    renderThemePresets() {
        const presets = this.getThemePresets();
        const container = document.getElementById('themePresets');
        if (!container) return;
        const active = this.config.themePreset || 'Dark';
        container.innerHTML = Object.keys(presets).map(name => `
            <button class="preset-pill${active===name?' active':''}" data-preset="${name}" data-i18n="theme_${name.toLowerCase()}">${this.translate(`theme_${name.toLowerCase()}`)}</button>
        `).join('');
        container.querySelectorAll('.preset-pill').forEach(btn => {
            btn.addEventListener('click', () => {
                const presetName = btn.dataset.preset;
                this.applyPreset(presetName);
                container.querySelectorAll('.preset-pill').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
            });
        });
        
        this.applyTranslations();
        
        this.applyThemeFromConfig();
    }

    getThemePresets() {
        return {
            'Dark': {
                '--primary-bg': '#0f0f0f',
                '--secondary-bg': '#1a1a1a',
                '--tertiary-bg': '#252525',
                '--accent-primary': '#00d4ff',
                '--accent-secondary': '#6366f1',
                '--text-primary': '#ffffff',
                '--text-secondary': '#a1a1aa',
                '--border-color': '#27272a',
                '--card-hover': 'rgba(0, 212, 255, 0.15)',
                '--icon-color': '#a1a1aa',
                '--icon-bg': 'transparent',
                '--icon-hover-color': '#ffffff',
                '--icon-hover-bg': 'rgba(0, 212, 255, 0.15)',
                '--title-icon-color': '#a1a1aa',
                '--title-icon-bg': 'transparent',
                '--title-icon-hover-color': '#ffffff',
                '--title-icon-hover-bg': 'rgba(0, 212, 255, 0.15)',
                '--bubble-icon-color': '#a1a1aa',
                '--bubble-icon-bg': 'rgba(26, 26, 26, 0.95)',
                '--bubble-icon-hover-color': '#ffffff',
                '--bubble-icon-hover-bg': 'rgba(0, 212, 255, 0.15)',
                '--bubble-home-icon-hover-bg': '#00d4ff',
                '--bubble-repairfix-icon-hover-bg': '#ff6b6b',
                '--bubble-library-icon-hover-bg': '#4ecdc4',
                '--bubble-manualinstall-icon-hover-bg': '#ffa726',
                '--bubble-settings-icon-hover-bg': '#ab47bc',
                '--bubble-home-icon-glow': '#00d4ff',
                '--bubble-repairfix-icon-glow': '#ff6b6b',
                '--bubble-library-icon-glow': '#4ecdc4',
                '--bubble-manualinstall-icon-glow': '#ffa726',
                '--bubble-settings-icon-glow': '#ab47bc',
                '--bubble-bypass-icon-hover-bg': '#ffd700',
                '--bubble-bypass-icon-glow': '#ffd700',
                '--hamburger-color': '#a1a1aa',
                '--hamburger-bg': 'rgba(0, 212, 255, 0.1)',
                '--hamburger-hover-color': '#ffffff',
                '--hamburger-hover-bg': 'rgba(0, 212, 255, 0.2)'
            },
            'Aqua': {
                '--primary-bg': '#06151a',
                '--secondary-bg': '#0b1f26',
                '--tertiary-bg': '#0e2730',
                '--accent-primary': '#00e0ff',
                '--accent-secondary': '#00ffa3',
                '--text-primary': '#e6faff',
                '--text-secondary': '#9dd6e3',
                '--border-color': '#11414d',
                '--card-hover': 'rgba(0, 224, 255, 0.15)',
                '--icon-color': '#9dd6e3',
                '--icon-bg': 'rgba(14, 39, 48, 0.5)',
                '--icon-hover-color': '#e6faff',
                '--icon-hover-bg': 'rgba(0, 224, 255, 0.2)',
                '--title-icon-color': '#9dd6e3',
                '--title-icon-bg': 'rgba(11, 31, 38, 0.6)',
                '--title-icon-hover-color': '#e6faff',
                '--title-icon-hover-bg': 'rgba(0, 224, 255, 0.25)',
                '--bubble-icon-color': '#9dd6e3',
                '--bubble-icon-bg': 'rgba(14, 39, 48, 0.9)',
                '--bubble-icon-hover-color': '#e6faff',
                '--bubble-icon-hover-bg': 'rgba(0, 224, 255, 0.3)',
                '--bubble-home-icon-hover-bg': '#00e0ff',
                '--bubble-repairfix-icon-hover-bg': '#ff6b6b',
                '--bubble-library-icon-hover-bg': '#4ecdc4',
                '--bubble-manualinstall-icon-hover-bg': '#ffa726',
                '--bubble-settings-icon-hover-bg': '#ab47bc',
                '--bubble-home-icon-glow': '#00e0ff',
                '--bubble-repairfix-icon-glow': '#ff6b6b',
                '--bubble-library-icon-glow': '#4ecdc4',
                '--bubble-manualinstall-icon-glow': '#ffa726',
                '--bubble-settings-icon-glow': '#ab47bc',
                '--bubble-bypass-icon-hover-bg': '#ffd700',
                '--bubble-bypass-icon-glow': '#ffd700',
                '--hamburger-color': '#9dd6e3',
                '--hamburger-bg': 'rgba(0, 224, 255, 0.1)',
                '--hamburger-hover-color': '#e6faff',
                '--hamburger-hover-bg': 'rgba(0, 224, 255, 0.2)'
            },
            'Sunset': {
                '--primary-bg': '#1a0b0b',
                '--secondary-bg': '#240f0f',
                '--tertiary-bg': '#301313',
                '--accent-primary': '#ff6b6b',
                '--accent-secondary': '#ff9f43',
                '--text-primary': '#fff2ed',
                '--text-secondary': '#ffd1c2',
                '--border-color': '#3a1a1a',
                '--card-hover': 'rgba(255, 107, 107, 0.15)',
                '--icon-color': '#ffd1c2',
                '--icon-bg': 'rgba(48, 19, 19, 0.4)',
                '--icon-hover-color': '#fff2ed',
                '--icon-hover-bg': 'rgba(255, 107, 107, 0.2)',
                '--title-icon-color': '#ffd1c2',
                '--title-icon-bg': 'rgba(36, 15, 15, 0.6)',
                '--title-icon-hover-color': '#fff2ed',
                '--title-icon-hover-bg': 'rgba(255, 107, 107, 0.25)',
                '--bubble-icon-color': '#ffd1c2',
                '--bubble-icon-bg': 'rgba(48, 19, 19, 0.9)',
                '--bubble-icon-hover-color': '#fff2ed',
                '--bubble-icon-hover-bg': 'rgba(255, 107, 107, 0.3)',
                '--bubble-home-icon-hover-bg': '#ff6b6b',
                '--bubble-repairfix-icon-hover-bg': '#ff6b6b',
                '--bubble-library-icon-hover-bg': '#4ecdc4',
                '--bubble-manualinstall-icon-hover-bg': '#ffa726',
                '--bubble-settings-icon-hover-bg': '#ab47bc',
                '--bubble-home-icon-glow': '#ff6b6b',
                '--bubble-repairfix-icon-glow': '#ff6b6b',
                '--bubble-library-icon-glow': '#4ecdc4',
                '--bubble-manualinstall-icon-glow': '#ffa726',
                '--bubble-settings-icon-glow': '#ab47bc',
                '--hamburger-color': '#ffd1c2',
                '--hamburger-bg': 'rgba(255, 107, 107, 0.1)',
                '--hamburger-hover-color': '#fff2ed',
                '--hamburger-hover-bg': 'rgba(255, 107, 107, 0.2)'
            },
            'Neon': {
                '--primary-bg': '#0a0a12',
                '--secondary-bg': '#0f0f1f',
                '--tertiary-bg': '#141430',
                '--accent-primary': '#00ffea',
                '--accent-secondary': '#b026ff',
                '--text-primary': '#e8e8ff',
                '--text-secondary': '#a7a7d6',
                '--border-color': '#20204d',
                '--card-hover': 'rgba(0, 255, 234, 0.15)',
                '--icon-color': '#a7a7d6',
                '--icon-bg': 'rgba(20, 20, 48, 0.6)',
                '--icon-hover-color': '#e8e8ff',
                '--icon-hover-bg': 'rgba(0, 255, 234, 0.25)',
                '--title-icon-color': '#a7a7d6',
                '--title-icon-bg': 'rgba(15, 15, 31, 0.7)',
                '--title-icon-hover-color': '#e8e8ff',
                '--title-icon-hover-bg': 'rgba(0, 255, 234, 0.3)',
                '--bubble-icon-color': '#a7a7d6',
                '--bubble-icon-bg': 'rgba(20, 20, 48, 0.95)',
                '--bubble-icon-hover-color': '#e8e8ff',
                '--bubble-icon-hover-bg': 'rgba(0, 255, 234, 0.4)',
                '--bubble-home-icon-hover-bg': '#00ffea',
                '--bubble-repairfix-icon-hover-bg': '#ff6b6b',
                '--bubble-library-icon-hover-bg': '#4ecdc4',
                '--bubble-manualinstall-icon-hover-bg': '#ffa726',
                '--bubble-settings-icon-hover-bg': '#ab47bc',
                '--bubble-home-icon-glow': '#00ffea',
                '--bubble-repairfix-icon-glow': '#ff6b6b',
                '--bubble-library-icon-glow': '#4ecdc4',
                '--bubble-manualinstall-icon-glow': '#ffa726',
                '--bubble-settings-icon-glow': '#ab47bc',
                '--bubble-bypass-icon-hover-bg': '#ffd700',
                '--bubble-bypass-icon-glow': '#ffd700',
                '--hamburger-color': '#a7a7d6',
                '--hamburger-bg': 'rgba(0, 255, 234, 0.1)',
                '--hamburger-hover-color': '#e8e8ff',
                '--hamburger-hover-bg': 'rgba(0, 255, 234, 0.2)'
            },
            'Light': {
                '--primary-bg': '#f6f7fb',
                '--secondary-bg': '#fff',
                '--tertiary-bg': '#eef1f7',
                '--accent-primary': '#3b82f6',
                '--accent-secondary': '#22c55e',
                '--text-primary': '#111827',
                '--text-secondary': '#374151',
                '--border-color': '#e5e7eb',
                '--card-hover': 'rgba(59, 130, 246, 0.1)',
                '--icon-color': '#6b7280',
                '--icon-bg': 'rgba(255, 255, 255, 0.8)',
                '--icon-hover-color': '#111827',
                '--icon-hover-bg': 'rgba(59, 130, 246, 0.15)',
                '--title-icon-color': '#6b7280',
                '--title-icon-bg': 'rgba(255, 255, 255, 0.9)',
                '--title-icon-hover-color': '#111827',
                '--title-icon-hover-bg': 'rgba(59, 130, 246, 0.2)',
                '--bubble-icon-color': '#6b7280',
                '--bubble-icon-bg': 'rgba(255, 255, 255, 0.95)',
                '--bubble-icon-hover-color': '#111827',
                '--bubble-icon-hover-bg': 'rgba(59, 130, 246, 0.25)',
                '--bubble-home-icon-hover-bg': '#3b82f6',
                '--bubble-repairfix-icon-hover-bg': '#ff6b6b',
                '--bubble-library-icon-hover-bg': '#4ecdc4',
                '--bubble-manualinstall-icon-hover-bg': '#ffa726',
                '--bubble-settings-icon-hover-bg': '#ab47bc',
                '--bubble-home-icon-glow': '#3b82f6',
                '--bubble-repairfix-icon-glow': '#ff6b6b',
                '--bubble-library-icon-glow': '#4ecdc4',
                '--bubble-manualinstall-icon-glow': '#ffa726',
                '--bubble-settings-icon-glow': '#ab47bc',
                '--bubble-bypass-icon-hover-bg': '#ffd700',
                '--bubble-bypass-icon-glow': '#ffd700',
                '--hamburger-color': '#6b7280',
                '--hamburger-bg': 'rgba(59, 130, 246, 0.1)',
                '--hamburger-hover-color': '#111827',
                '--hamburger-hover-bg': 'rgba(59, 130, 246, 0.2)'
            }
        };
    }

    applyPreset(name) {
        const preset = this.getThemePresets()[name];
        if (!preset) return;
        
        Object.entries(preset).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));
        
        Object.entries(preset).forEach(([k,v]) => {
            const id = `color-${k.replace(/^--/, '')}`;
            const el = document.getElementById(id);
            if (el) el.value = v;
        });
        
        this.updateMiniGridFromPreset(preset);
        
        setTimeout(() => {
            this.updateAdvancedColorsFromCurrentCSS();
        }, 50);
        
        this.updateIconDesignerFromPreset(preset);
        
        this.refreshHoverStyles();
        
        this.updateConfig({ themePreset: name, customTheme: preset });
        
        this.showNotification('success', 'Tema uygulandı: ' + name, 'success');
    }

    updateMiniGridFromPreset(preset) {
        const miniGridInputs = {
            'mini-accent-primary': '--accent-primary',
            'mini-primary-bg': '--primary-bg', 
            'mini-secondary-bg': '--secondary-bg',
            'mini-card-hover': '--card-hover',
            'mini-icon-color': '--icon-color'
        };
        
        Object.entries(miniGridInputs).forEach(([inputId, cssVar]) => {
            const input = document.getElementById(inputId);
            if (input && preset[cssVar]) {
                input.value = this.toHexColor(preset[cssVar]);
            }
        });
    }

    updateMiniGridFromCurrentCSS() {
        const miniGridInputs = {
            'mini-accent-primary': '--accent-primary',
            'mini-primary-bg': '--primary-bg', 
            'mini-secondary-bg': '--secondary-bg',
            'mini-card-hover': '--card-hover',
            'mini-icon-color': '--icon-color'
        };
        
        Object.entries(miniGridInputs).forEach(([inputId, cssVar]) => {
            const input = document.getElementById(inputId);
            if (input) {
                const currentValue = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
                if (currentValue) {
                    input.value = this.toHexColor(currentValue);
                }
            }
        });
    }

    updateAdvancedColorsFromCurrentCSS() {
        const colorInputs = document.querySelectorAll('#colorGrid input[type="color"]');
        colorInputs.forEach(input => {
            const cssVar = input.dataset.var;
            if (cssVar) {
                const currentValue = getComputedStyle(document.documentElement).getPropertyValue(cssVar).trim();
                if (currentValue) {
                    input.value = this.toHexColor(currentValue);
                }
            }
        });
    }

    updateIconDesignerFromPreset(preset) {
        const iconInputs = {
            'bubbleHomeIconColor': '--bubble-home-icon-color',
            'bubbleHomeIconBg': '--bubble-home-icon-bg',
            'bubbleHomeIconHoverColor': '--bubble-home-icon-hover-color',
            'bubbleHomeIconHoverBg': '--bubble-home-icon-hover-bg',
            'bubbleHomeIconGlow': '--bubble-home-icon-glow',
            'bubbleRepairFixIconColor': '--bubble-repairfix-icon-color',
            'bubbleRepairFixIconBg': '--bubble-repairfix-icon-bg',
            'bubbleRepairFixIconHoverColor': '--bubble-repairfix-icon-hover-color',
            'bubbleRepairFixIconHoverBg': '--bubble-repairfix-icon-hover-bg',
            'bubbleRepairFixIconGlow': '--bubble-repairfix-icon-glow',
            'bubbleBypassIconColor': '--bubble-bypass-icon-color',
            'bubbleBypassIconBg': '--bubble-bypass-icon-bg',
            'bubbleBypassIconHoverColor': '--bubble-bypass-icon-hover-color',
            'bubbleBypassIconHoverBg': '--bubble-bypass-icon-hover-bg',
            'bubbleBypassIconGlow': '--bubble-bypass-icon-glow',
            'bubbleLibraryIconColor': '--bubble-library-icon-color',
            'bubbleLibraryIconBg': '--bubble-library-icon-bg',
            'bubbleLibraryIconHoverColor': '--bubble-library-icon-hover-color',
            'bubbleLibraryIconHoverBg': '--bubble-library-icon-hover-bg',
            'bubbleLibraryIconGlow': '--bubble-library-icon-glow',
            'bubbleManualInstallIconColor': '--bubble-manualinstall-icon-color',
            'bubbleManualInstallIconBg': '--bubble-manualinstall-icon-bg',
            'bubbleManualInstallIconHoverColor': '--bubble-manualinstall-icon-hover-color',
            'bubbleManualInstallIconHoverBg': '--bubble-manualinstall-icon-hover-bg',
            'bubbleManualInstallIconGlow': '--bubble-manualinstall-icon-glow',
            'bubbleSettingsIconColor': '--bubble-settings-icon-color',
            'bubbleSettingsIconBg': '--bubble-settings-icon-bg',
            'bubbleSettingsIconHoverColor': '--bubble-settings-icon-hover-color',
            'bubbleSettingsIconHoverBg': '--bubble-settings-icon-hover-bg',
            'bubbleSettingsIconGlow': '--bubble-settings-icon-glow',
            'hamburgerColor': '--hamburger-color',
            'hamburgerHoverColor': '--hamburger-hover-color',
            'hamburgerHoverBg': '--hamburger-hover-bg'
        };
        
        Object.entries(iconInputs).forEach(([inputId, cssVar]) => {
            const input = document.getElementById(inputId);
            if (input && preset[cssVar]) {
                input.value = this.toHexColor(preset[cssVar]);
                input.dispatchEvent(new Event('change'));
            }
        });
        
        setTimeout(() => {
            this.refreshHoverStyles();
        }, 100);
    }

    saveCurrentTheme() {
        const vars = {};
        document.querySelectorAll('#settings-page input[type="color"]').forEach(inp => {
            const cssVar = inp.dataset.var;
            vars[cssVar] = inp.value;
        });
        this.updateConfig({ customTheme: vars });
        this.showNotification('success', 'settings_saved', 'success');
    }

    resetThemeToDefault() {
        const def = this.getThemePresets()['Dark'];
        if (!def) return;
        Object.entries(def).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));
        Object.entries(def).forEach(([k,v]) => {
            const id = `color-${k.replace(/^--/, '')}`;
            const el = document.getElementById(id);
            if (el) el.value = v;
        });
        this.updateConfig({ themePreset: 'Dark', customTheme: def });
    }

    exportTheme() {
        const theme = this.getCurrentTheme();
        const blob = new Blob([JSON.stringify(theme, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'paradise-theme.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    importTheme(e) {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const obj = JSON.parse(reader.result);
                if (obj && typeof obj === 'object') {
                    Object.entries(obj).forEach(([k,v]) => document.documentElement.style.setProperty(k, v));
                    Object.entries(obj).forEach(([k,v]) => {
                        const id = `color-${k.replace(/^--/, '')}`;
                        const el = document.getElementById(id);
                        if (el && typeof v === 'string') el.value = this.toHexColor(v);
                    });
                    this.updateConfig({ customTheme: obj, themePreset: 'Custom' });
                }
            } catch {}
        };
        reader.readAsText(file);
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

			try {
				const relResp = await fetch('https://api.github.com/repos/muhammetdag/ParadiseSteamLibrary/releases/latest', { headers, cache: 'no-store' });
				if (relResp.ok) {
					const data = await relResp.json();
					latestTag = data.tag_name || null;
					latestUrl = data.html_url || latestUrl;
				}
			} catch {}

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

			appVersionEl.textContent = latestTag || 'v?';
			releaseLinkEl.href = latestUrl;

            let localVersion = await ipcRenderer.invoke('get-app-version');
            if (!localVersion) {
                try { localVersion = require('../../package.json').version; } catch {}
            }
            if (localVersion && latestTag) {
                const normalizedLocal = localVersion.toString().startsWith('v') ? localVersion : `v${localVersion}`;
                if (this.isSemverNewer(latestTag, normalizedLocal)) {
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

    async confirmGameWithDLCs(appId, selectedDLCs) {
        await this.addGameToLibraryWithDLCs(appId, selectedDLCs);
    }

    async addGameToLibraryWithDLCs(appId, selectedDLCs) {
        this.showLoading();
        
        if (!this.config.steamPath) {
            this.hideLoading();
            this.showNotification('error', 'steam_path_failed', 'error');
            return;
        }
        try {
            const result = await ipcRenderer.invoke('add-game-to-library', appId, selectedDLCs);
            if (result.success) {
                this.showNotification('success', 'Oyun başarıyla kütüphaneye eklendi', 'success');
                this.closeModal('dlcModal');
                this.showSteamRestartDialog();
            }
        } catch (error) {
            console.error('Failed to add game:', error);
            this.showNotification('error', 'Oyun kütüphaneye eklenemedi', 'error');
        } finally {
            this.hideLoading();
        }
    }

    /* Online Pass kaldırıldı */
    async cacheOnlineGameNames() {
        if (!this.onlinePassGames || this.onlinePassGames.length === 0) return;
        
        try {
            this.onlinePassGameNames = {};
            
            const uniqueAppIds = [...new Set(this.onlinePassGames)];
            console.log(`🔄 Oyun isimleri cache'leniyor: ${uniqueAppIds.length} unique oyun`);
            
            for (const appId of uniqueAppIds) {
                try {
                    const gameDetails = await fetchSteamAppDetails(appId, 'TR', 'turkish');
                    if (gameDetails && gameDetails.name) {
                        this.onlinePassGameNames[appId] = gameDetails.name;
                        console.log(`✅ ${appId}: ${gameDetails.name}`);
                    }
                } catch (error) {
                    console.log(`❌ Oyun ismi alınamadı (${appId}):`, error);
                }
            }
            
            console.log(`✅ ${Object.keys(this.onlinePassGameNames).length} oyun ismi cache'lendi`);
        } catch (error) {
            console.error('Oyun isimleri cache\'lenirken hata:', error);
        }
    }

    async loadOnlinePassGames() {
        const cc = this.countryCode || 'TR';
        const lang = this.getSelectedLang();
        var onlineGrid = document.getElementById('onlinePassPage');
        if (!onlineGrid) return;
        
        this.onlinePassGamesPerPage = 12; // Sayfa başına 12 oyun
        this.onlinePassCurrentPage = 0;
        
        onlineGrid.innerHTML = '';
        
        try {
            console.log('🔄 Online oyunlar yükleniyor... (1. deneme)');
            
            let res = await fetch('https://api.muhammetdag.com/steamlib/online/games.php', { 
                cache: 'no-store',
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            if (!res.ok) {
                if (res.status === 401) {
                    throw new Error('401_UNAUTHORIZED');
                }
                throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }
            
            let data = await res.json();
            
            if (data === false || data === null || (Array.isArray(data) && data.length === 0)) {
                throw new Error('401_UNAUTHORIZED');
            }
            
            if (!Array.isArray(data)) {
                throw new Error('Online oyun listesi alınamadı');
            }
            
            console.log(`📊 1. API çağrısı: ${data.length} oyun`);
            
            let firstFiltered = data
                .filter(game => game.result === true)
                .map(game => game.appid)
                .filter(appid => appid != null && appid !== undefined && appid !== '');
            
            console.log(`✅ 1. API'den filtrelenmiş: ${firstFiltered.length} oyun`);
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            console.log('🔄 Online oyunlar tekrar kontrol ediliyor... (2. deneme)');
            
            res = await fetch('https://api.muhammetdag.com/steamlib/online/games.php', { 
                cache: 'no-store',
                headers: {
                    'Accept': 'application/json',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            
            if (!res.ok) {
                if (res.status === 401) {
                    throw new Error('401_UNAUTHORIZED');
                }
                throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            }
            
            const secondData = await res.json();
            
            if (secondData === false || secondData === null || (Array.isArray(secondData) && secondData.length === 0)) {
                throw new Error('401_UNAUTHORIZED');
            }
            
            if (!Array.isArray(secondData)) {
                throw new Error('İkinci API çağrısı başarısız');
            }
            
            console.log(`📊 2. API çağrısı: ${secondData.length} oyun`);
            
            let secondFiltered = secondData
                .filter(game => game.result === true)
                .map(game => game.appid)
                .filter(appid => appid != null && appid !== undefined && appid !== '');
            
            console.log(`✅ 2. API'den filtrelenmiş: ${secondFiltered.length} oyun`);
            
            const combinedData = [...firstFiltered, ...secondFiltered];
            console.log(`📊 Birleştirilmiş filtrelenmiş veri: ${combinedData.length} oyun`);
            
            this.onlinePassGames = [...new Set(combinedData)];
            console.log(`🧹 Duplicate temizlendikten sonra: ${this.onlinePassGames.length} adet`);
            
            this.onlinePassFilteredGames = this.onlinePassGames;
            
            this.renderOnlinePassGames();
            
            await this.cacheOnlineGameNames();
            
            console.log('✅ Online oyunlar başarıyla yüklendi');
            
        } catch (err) {
            console.error('Error loading online pass games:', err);
            
            if (err.message && err.message.includes('401_UNAUTHORIZED')) {
                this.showOnlineFixRoleModal();
            } else {
            onlineGrid.innerHTML = `<div style="color:#ff6b6b;padding:20px;text-align:center;">Online oyunlar yüklenemedi: ${err.message}</div>`;
            }
        }
    }

    showOnlineFixRoleModal() {
        if (document.getElementById('onlineFixRoleModal')) {
            console.log('Modal zaten açık, yeni modal açılmıyor');
            return;
        }
        
        console.log('Online fix rol modal\'ı açılıyor');
        
        const modalHTML = `
            <div id="onlineFixRoleModal" style="
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 9999;
            ">
                <div style="
                    background: #1a1a1a;
                    border-radius: 16px;
                    padding: 40px;
                    max-width: 500px;
                    width: 90%;
                    text-align: center;
                    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
                    border: 1px solid #333;
                ">
                    <div style="font-size: 48px; margin-bottom: 20px;">🔒</div>
                    <h2 style="color: #fff; margin-bottom: 20px; font-size: 24px;">Online Fix Rolü Gerekli</h2>
                    <p style="color: #ccc; margin-bottom: 20px; line-height: 1.6;">
                        Discord sunucumuzda online fix rolüne sahip değilsiniz. Online fix sistemini kullanmak için Discord üzerinden görevleri yaparak rolünüzü almanız lazım.
                    </p>
                    <p style="color: #ccc; margin-bottom: 30px; line-height: 1.6;">
                        Rolü aldıktan sonra uygulama üzerindeki hesabınızdan çıkıp yeniden girerseniz rol tanımlanır.
                    </p>
                    <div style="display: flex; gap: 15px; justify-content: center;">
                        <button id="joinDiscordBtn" style="
                            background: #5865F2;
                            color: white;
                            border: none;
                            padding: 12px 24px;
                            border-radius: 8px;
                            font-size: 16px;
                            font-weight: 600;
                            cursor: pointer;
                            display: flex;
                            align-items: center;
                            gap: 8px;
                        ">
                            <span>💬</span>
                            Discord'a Katıl
                        </button>
                        <button id="closeRoleModalBtn" style="
                            background: #666;
                            color: white;
                            border: none;
                            padding: 12px 24px;
                            border-radius: 8px;
                            font-size: 16px;
                            font-weight: 600;
                            cursor: pointer;
                        ">
                            Kapat
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
        document.getElementById('joinDiscordBtn').onclick = () => {
            try {
                ipcRenderer.invoke('open-in-chrome', 'https://discord.gg/paradisedev');
            } catch {
                window.open('https://discord.gg/paradisedev', '_blank');
            }
        };
        
        document.getElementById('closeRoleModalBtn').onclick = () => {
            document.getElementById('onlineFixRoleModal').remove();
        };
        
        document.getElementById('onlineFixRoleModal').onclick = (e) => {
            if (e.target.id === 'onlineFixRoleModal') {
                document.getElementById('onlineFixRoleModal').remove();
            }
        };
        
        const handleEscKey = (e) => {
            if (e.key === 'Escape') {
                document.getElementById('onlineFixRoleModal').remove();
                document.removeEventListener('keydown', handleEscKey);
            }
        };
        document.addEventListener('keydown', handleEscKey);
    }

    showBypassRoleModal() {
        if (document.getElementById('bypassRoleModal')) {
            console.log('Bypass modal zaten açık, yeni modal açılmıyor');
            return;
        }
        
        console.log('Bypass rol modal\'ı açılıyor');
        
        const modalHTML = `
            <div id="bypassRoleModal" style="
                position: fixed;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
                background: rgba(0, 0, 0, 0.8);
                display: flex;
                justify-content: center;
                align-items: center;
                z-index: 9999;
            ">
                <div style="
                    background: #1a1a1a;
                    border-radius: 16px;
                    padding: 40px;
                    max-width: 500px;
                    width: 90%;
                    text-align: center;
                    box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
                    border: 1px solid #333;
                ">
                    <div style="font-size: 48px; margin-bottom: 20px;">🔒</div>
                    <h2 style="color: #fff; margin-bottom: 20px; font-size: 24px;">Bypass Rolü Gerekli</h2>
                    <p style="color: #ccc; margin-bottom: 20px; line-height: 1.6;">
                        Discord sunucumuzda bypass rolüne sahip değilsiniz. Bypass sistemini kullanmak için Discord üzerinden görevleri yaparak rolünüzü almanız lazım.
                    </p>
                    <p style="color: #ccc; margin-bottom: 30px; line-height: 1.6;">
                        Rolü aldıktan sonra uygulama üzerindeki hesabınızdan çıkıp yeniden girerseniz rol tanımlanır.
                    </p>
                    <div style="display: flex; gap: 15px; justify-content: center;">
                        <button id="joinDiscordBypassBtn" style="
                            background: #5865F2;
                            color: white;
                            border: none;
                            padding: 12px 24px;
                            border-radius: 8px;
                            font-size: 16px;
                            font-weight: 600;
                            cursor: pointer;
                            display: flex;
                            align-items: center;
                            gap: 8px;
                        ">
                            <span>💬</span>
                            Discord'a Katıl
                        </button>
                        <button id="closeBypassModalBtn" style="
                            background: #666;
                            color: white;
                            border: none;
                            padding: 12px 24px;
                            border-radius: 8px;
                            font-size: 16px;
                            font-weight: 600;
                            cursor: pointer;
                        ">
                            Kapat
                        </button>
                    </div>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', modalHTML);
        
        document.getElementById('joinDiscordBypassBtn').onclick = () => {
            try {
                ipcRenderer.invoke('open-in-chrome', 'https://discord.gg/paradisedev');
            } catch {
                window.open('https://discord.gg/paradisedev', '_blank');
            }
        };
        
        document.getElementById('closeBypassModalBtn').onclick = () => {
            document.getElementById('bypassRoleModal').remove();
        };
        
        document.getElementById('bypassRoleModal').onclick = (e) => {
            if (e.target.id === 'bypassRoleModal') {
                document.getElementById('bypassRoleModal').remove();
            }
        };
        
        const handleEscKey = (e) => {
            if (e.key === 'Escape') {
                document.getElementById('bypassRoleModal').remove();
                document.removeEventListener('keydown', handleEscKey);
            }
        };
        document.addEventListener('keydown', handleEscKey);
    }

    async renderOnlinePassGames(list) {
        const onlineGrid = document.getElementById('onlinePassPage');
        if (!onlineGrid) return;
        
        onlineGrid.innerHTML = ``;
        
        const games = this.onlinePassFilteredGames;
        if (!games || games.length === 0) {
            onlineGrid.innerHTML = `<div style="color:#94a3b8;padding:40px;text-align:center;font-size:16px;">Mevcut online oyun bulunamadı</div>`;
            return;
        }
        
        const uniqueGames = [...new Set(games)];
        
        const startIndex = this.onlinePassCurrentPage * this.onlinePassGamesPerPage;
        const endIndex = startIndex + this.onlinePassGamesPerPage;
        const currentPageGames = uniqueGames.slice(startIndex, endIndex);
        const totalPages = Math.ceil(uniqueGames.length / this.onlinePassGamesPerPage);
        
        const existing = document.getElementById('online-pass-grid');
        if (existing) {
            existing.remove();
        }
        
        const grid = document.createElement('div');
        grid.className = 'online-pass-grid';
        grid.id = 'online-pass-grid';
        grid.style.cssText = `
            padding: 24px 0 0 0;
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
            gap: 20px;
            max-width: 100%;
        `;
        
        const createGameCard = async (gameId) => {
            if (!gameId) {
                console.warn('Skipping null gameId in createGameCard');
                return null;
            }
            
            const existingCard = document.querySelector(`[data-appid="${gameId}"]`);
            if (existingCard) {
                console.warn(`❌ Duplicate oyun kartı engellendi: ${gameId}`);
                return null;
            }
            
            console.log(`✅ Oyun kartı oluşturuluyor: ${gameId}`);
            
            const card = document.createElement('div');
            card.className = 'game-card';
            card.style.background = '#181c22';
            card.style.borderRadius = '14px';
            card.style.cursor = 'pointer';
            card.style.boxShadow = '0 2px 12px #0002';
            
            try {
                let gameName = `Oyun ID: ${gameId}`;
                let imageUrl = await this.getSharedHeader(gameId);
                
                if (this.onlinePassGameNames && this.onlinePassGameNames[gameId]) {
                    gameName = this.onlinePassGameNames[gameId];
                }
                
                const steamUrl = `https://store.steampowered.com/app/${gameId}`;
                
                card.innerHTML = `
                    <img src="${imageUrl}" alt="${gameName}" class="game-image" loading="lazy" style="width:100%;height:160px;object-fit:cover;border-radius:12px 12px 0 0;" onerror="this.onerror=null;this.src='pdbanner.png'" data-appid="${gameId}" data-fallback="0">
                    <div class="game-info" style="padding:12px;">
                        <h3 class="game-title" style="font-size:18px;font-weight:700;margin-bottom:4px;">${gameName}</h3>
                        <div class="game-meta" style="margin-bottom:6px;">
                        </div>
                        <button class="game-btn secondary" style="width:100%;margin-top:8px;background:#222;color:#00bfff;border:1px solid #00bfff;" onclick="event.stopPropagation(); window.open('${steamUrl}','_blank')">${this.translate('steam_page')}</button>
                    </div>
                `;
            } catch (error) {
                const steamUrl = `https://store.steampowered.com/app/${gameId}`;
                const imageUrl = await this.getSharedHeader(gameId);
                
                card.innerHTML = `
                    <img src="${imageUrl}" alt="Game ${gameId}" class="game-image" loading="lazy" style="width:100%;height:160px;object-fit:cover;border-radius:12px 12px 0 0;" onerror="this.onerror=null;this.src='pdbanner.png'" data-appid="${gameId}" data-fallback="0">
                    <div class="game-info" style="padding:12px;">
                        <h3 class="game-title" style="font-size:18px;font-weight:700;margin-bottom:4px;">${this.translate('game_id')}: ${gameId}</h3>
                        <div class="game-meta" style="margin-bottom:6px;">
                        </div>
                        <button class="game-btn secondary" style="width:100%;margin-top:8px;background:#222;color:#00bfff;border:1px solid #00bfff;" onclick="event.stopPropagation(); window.open('${steamUrl}','_blank')">${this.translate('steam_page')}</button>
                    </div>
                `;
            }
            
            return card;
        };

        const cardPromises = currentPageGames.map(game => createGameCard(game));
        const cards = await Promise.all(cardPromises);
        
        cards.filter(card => card !== null).forEach(card => {
            grid.appendChild(card);
        });
        onlineGrid.appendChild(grid);
        
        if (totalPages > 1) {
            const paginationContainer = document.createElement('div');
            paginationContainer.style.display = 'flex';
            paginationContainer.style.justifyContent = 'center';
            paginationContainer.style.alignItems = 'center';
            paginationContainer.style.gap = '12px';
            paginationContainer.style.marginTop = '32px';
            paginationContainer.style.padding = '16px';
            
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
            
            const pageInfo = document.createElement('span');
            const pageInfoText = this.translate('page_info')
                .replace('{current}', this.onlinePassCurrentPage + 1)
                .replace('{total}', totalPages)
                .replace('{count}', games.length);
            pageInfo.textContent = pageInfoText;
            pageInfo.style.color = '#fff';
            pageInfo.style.fontSize = '14px';
            
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
            
            await ipcRenderer.invoke('download-online-file', appId);
            
            this.showManualInstallInfo();
            
            this.showNotification('success', this.translate('download_success'), 'success');
        } catch (err) {
            console.error('Download error:', err);
            
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

    setupActiveUsersTracking() {
        ipcRenderer.on('update-active-users', (event, count) => {
            this.updateActiveUsersDisplay(count);
        });
        
        ipcRenderer.on('online-fix-401-error', () => {
            console.log('401 hatası bildirimi alındı, modal gösteriliyor');
            this.showOnlineFixRoleModal();
        });

        this.refreshActiveUsersCount();
        
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
                
                indicator.style.transform = 'scale(1.1)';
                setTimeout(() => {
                    indicator.style.transform = 'scale(1)';
                }, 200);
            }
      }
    }

    setupLoadingCustomization() {
        document.getElementById('toggleAdvancedLoading')?.addEventListener('click', () => this.toggleAdvancedLoading());

        document.getElementById('loadingSpinnerColor')?.addEventListener('input', (e) => this.updateLoadingPreview());
        document.getElementById('loadingBgColor')?.addEventListener('input', (e) => this.updateLoadingPreview());
        document.getElementById('loadingTextColor')?.addEventListener('input', (e) => this.updateLoadingPreview());

        document.getElementById('loadingSpinnerSize')?.addEventListener('input', (e) => this.updateLoadingPreview());
        document.getElementById('loadingSpinnerSpeed')?.addEventListener('input', (e) => this.updateLoadingPreview());
        document.getElementById('loadingBgOpacity')?.addEventListener('input', (e) => this.updateLoadingPreview());
        document.getElementById('loadingBlurEffect')?.addEventListener('input', (e) => this.updateLoadingPreview());
        document.getElementById('loadingTextSize')?.addEventListener('input', (e) => this.updateLoadingPreview());
        document.getElementById('loadingTextWeight')?.addEventListener('change', (e) => this.updateLoadingPreview());

        document.getElementById('loadingPulseAnimation')?.addEventListener('change', (e) => this.updateLoadingPreview());
        document.getElementById('loadingTextGlow')?.addEventListener('change', (e) => this.updateLoadingPreview());
        document.getElementById('loadingSpinnerGlow')?.addEventListener('change', (e) => this.updateLoadingPreview());

        document.querySelectorAll('.preset-btn[data-preset]').forEach(btn => {
            btn.addEventListener('click', (e) => this.applyLoadingPreset(e.target.dataset.preset));
        });

        document.getElementById('loadingSave')?.addEventListener('click', () => this.saveLoadingSettings());
        document.getElementById('loadingReset')?.addEventListener('click', () => this.resetLoadingSettings());
        document.getElementById('loadingExport')?.addEventListener('click', () => this.exportLoadingSettings());
        document.getElementById('loadingImport')?.addEventListener('change', (e) => this.importLoadingSettings(e));
        document.getElementById('testLoadingBtn')?.addEventListener('click', () => this.testLoadingScreen());

        this.updateLoadingPreview();
        this.loadLoadingSettings();
    }

    toggleAdvancedLoading() {
        const advancedSettings = document.getElementById('loadingAdvancedSettings');
        const toggleBtn = document.getElementById('toggleAdvancedLoading');
        
        if (advancedSettings && toggleBtn) {
            const isVisible = advancedSettings.style.display !== 'none';
            advancedSettings.style.display = isVisible ? 'none' : 'block';
            toggleBtn.classList.toggle('active', !isVisible);
        }
    }

    updateLoadingPreview() {
        const preview = document.getElementById('loadingPreview');
        if (!preview) return;

        const spinnerColor = document.getElementById('loadingSpinnerColor')?.value || '#00d4ff';
        const bgColor = document.getElementById('loadingBgColor')?.value || '#0f0f0f';
        const textColor = document.getElementById('loadingTextColor')?.value || '#ffffff';
        const spinnerSize = document.getElementById('loadingSpinnerSize')?.value || 60;
        const spinnerSpeed = document.getElementById('loadingSpinnerSpeed')?.value || 1.2;
        const bgOpacity = document.getElementById('loadingBgOpacity')?.value || 95;
        const blurEffect = document.getElementById('loadingBlurEffect')?.value || 20;
        const textSize = document.getElementById('loadingTextSize')?.value || 16;
        const textWeight = document.getElementById('loadingTextWeight')?.value || 600;
        const pulseAnimation = document.getElementById('loadingPulseAnimation')?.checked || false;
        const textGlow = document.getElementById('loadingTextGlow')?.checked || false;
        const spinnerGlow = document.getElementById('loadingSpinnerGlow')?.checked || false;

        const previewContent = preview.querySelector('.loading-preview-content');
        const previewSpinner = preview.querySelector('.loading-preview-spinner');
        const previewRing = preview.querySelector('.loading-preview-ring');
        const previewText = preview.querySelector('.loading-preview-text');

        if (previewContent) {
            previewContent.style.background = `rgba(${this.hexToRgb(bgColor)}, ${bgOpacity / 100})`;
            previewContent.style.backdropFilter = `blur(${blurEffect}px)`;
            previewContent.style.border = `1px solid ${spinnerColor}40`;
        }

        if (previewSpinner) {
            const maxPreviewSize = 80; // Maximum size for preview
            const actualSize = Math.min(spinnerSize, maxPreviewSize);
            
            previewSpinner.style.width = `${actualSize}px`;
            previewSpinner.style.height = `${actualSize}px`;
            previewSpinner.style.transform = 'none'; // Reset any previous transform
        }

        if (previewRing) {
            const maxPreviewSize = 80;
            const actualSize = Math.min(spinnerSize, maxPreviewSize);
            
            previewRing.style.width = `${actualSize}px`;
            previewRing.style.height = `${actualSize}px`;
            previewRing.style.animationDuration = `${spinnerSpeed}s`;
            
            previewRing.style.setProperty('--spinner-color', spinnerColor);
            
            if (spinnerGlow) {
                previewRing.style.filter = `drop-shadow(0 0 10px ${spinnerColor}80)`;
            } else {
                previewRing.style.filter = 'none';
            }
        }

        if (previewText) {
            previewText.style.color = textColor;
            previewText.style.fontSize = `${textSize}px`;
            previewText.style.fontWeight = textWeight;
            if (textGlow) {
                previewText.style.textShadow = `0 0 10px ${textColor}80`;
            } else {
                previewText.style.textShadow = 'none';
            }
        }

        if (pulseAnimation) {
            previewContent.style.animation = 'loadingPulse 2s ease-in-out infinite';
        } else {
            previewContent.style.animation = 'none';
        }

        this.updateRangeValues();
    }

    updateRangeValues() {
        const ranges = [
            { id: 'loadingSpinnerSize', suffix: 'px' },
            { id: 'loadingSpinnerSpeed', suffix: 's' },
            { id: 'loadingBgOpacity', suffix: '%' },
            { id: 'loadingBlurEffect', suffix: 'px' },
            { id: 'loadingTextSize', suffix: 'px' }
        ];

        ranges.forEach(range => {
            const input = document.getElementById(range.id);
            const valueSpan = input?.nextElementSibling;
            if (input && valueSpan) {
                valueSpan.textContent = input.value + range.suffix;
            }
        });
    }

    hexToRgb(hex) {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? `${parseInt(result[1], 16)}, ${parseInt(result[2], 16)}, ${parseInt(result[3], 16)}` : '0, 0, 0';
    }

    applyLoadingPreset(preset) {
        const presets = {
            default: {
                spinnerColor: '#00d4ff',
                bgColor: '#0f0f0f',
                textColor: '#ffffff',
                spinnerSize: 60,
                spinnerSpeed: 1.2,
                bgOpacity: 95,
                blurEffect: 20,
                textSize: 16,
                textWeight: 600,
                pulseAnimation: true,
                textGlow: true,
                spinnerGlow: true
            },
            neon: {
                spinnerColor: '#ff00ff',
                bgColor: '#000000',
                textColor: '#00ffff',
                spinnerSize: 80,
                spinnerSpeed: 0.8,
                bgOpacity: 90,
                blurEffect: 25,
                textSize: 18,
                textWeight: 700,
                pulseAnimation: true,
                textGlow: true,
                spinnerGlow: true
            },
            minimal: {
                spinnerColor: '#666666',
                bgColor: '#ffffff',
                textColor: '#333333',
                spinnerSize: 40,
                spinnerSpeed: 1.5,
                bgOpacity: 100,
                blurEffect: 0,
                textSize: 14,
                textWeight: 400,
                pulseAnimation: false,
                textGlow: false,
                spinnerGlow: false
            },
            gaming: {
                spinnerColor: '#ff6b35',
                bgColor: '#1a1a1a',
                textColor: '#ffffff',
                spinnerSize: 70,
                spinnerSpeed: 1.0,
                bgOpacity: 95,
                blurEffect: 15,
                textSize: 16,
                textWeight: 600,
                pulseAnimation: true,
                textGlow: true,
                spinnerGlow: true
            },
            elegant: {
                spinnerColor: '#9c27b0',
                bgColor: '#2d2d2d',
                textColor: '#ffffff',
                spinnerSize: 65,
                spinnerSpeed: 1.8,
                bgOpacity: 98,
                blurEffect: 10,
                textSize: 15,
                textWeight: 500,
                pulseAnimation: false,
                textGlow: true,
                spinnerGlow: false
            },
            dark: {
                spinnerColor: '#ffffff',
                bgColor: '#000000',
                textColor: '#cccccc',
                spinnerSize: 55,
                spinnerSpeed: 1.3,
                bgOpacity: 100,
                blurEffect: 0,
                textSize: 16,
                textWeight: 600,
                pulseAnimation: false,
                textGlow: false,
                spinnerGlow: false
            }
        };

        const presetData = presets[preset];
        if (!presetData) return;

        Object.entries(presetData).forEach(([key, value]) => {
            const element = document.getElementById(`loading${key.charAt(0).toUpperCase() + key.slice(1)}`);
            if (element) {
                if (element.type === 'checkbox') {
                    element.checked = value;
                } else {
                    element.value = value;
                }
            }
        });

        this.updateLoadingPreview();
    }

    async saveLoadingSettings() {
        try {
            const settings = this.getLoadingSettings();
            await this.updateConfig({ loadingSettings: settings });
            this.showNotification('success', 'Yükleme ekranı ayarları kaydedildi', 'success');
        } catch (error) {
            console.error('Loading settings save error:', error);
            this.showNotification('error', 'Ayarlar kaydedilemedi', 'error');
        }
    }

    async loadLoadingSettings() {
        try {
            const settings = this.config.loadingSettings;
            if (settings) {
                this.applyLoadingSettings(settings);
            }
        } catch (error) {
            console.error('Loading settings load error:', error);
        }
    }

    getLoadingSettings() {
        return {
            spinnerColor: document.getElementById('loadingSpinnerColor')?.value || '#00d4ff',
            bgColor: document.getElementById('loadingBgColor')?.value || '#0f0f0f',
            textColor: document.getElementById('loadingTextColor')?.value || '#ffffff',
            spinnerSize: parseInt(document.getElementById('loadingSpinnerSize')?.value) || 60,
            spinnerSpeed: parseFloat(document.getElementById('loadingSpinnerSpeed')?.value) || 1.2,
            bgOpacity: parseInt(document.getElementById('loadingBgOpacity')?.value) || 95,
            blurEffect: parseInt(document.getElementById('loadingBlurEffect')?.value) || 20,
            textSize: parseInt(document.getElementById('loadingTextSize')?.value) || 16,
            textWeight: parseInt(document.getElementById('loadingTextWeight')?.value) || 600,
            pulseAnimation: document.getElementById('loadingPulseAnimation')?.checked || false,
            textGlow: document.getElementById('loadingTextGlow')?.checked || false,
            spinnerGlow: document.getElementById('loadingSpinnerGlow')?.checked || false
        };
    }

    applyLoadingSettings(settings) {
        Object.entries(settings).forEach(([key, value]) => {
            const element = document.getElementById(`loading${key.charAt(0).toUpperCase() + key.slice(1)}`);
            if (element) {
                if (element.type === 'checkbox') {
                    element.checked = value;
                } else {
                    element.value = value;
                }
            }
        });
        this.updateLoadingPreview();
    }

    resetLoadingSettings() {
        this.applyLoadingPreset('default');
        this.showNotification('info', 'Yükleme ekranı ayarları sıfırlandı', 'info');
    }

    exportLoadingSettings() {
        try {
            const settings = this.getLoadingSettings();
            const dataStr = JSON.stringify(settings, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            
            const link = document.createElement('a');
            link.href = URL.createObjectURL(dataBlob);
            link.download = 'loading-settings.json';
            link.click();
            
            this.showNotification('success', 'Ayarlar dışa aktarıldı', 'success');
        } catch (error) {
            console.error('Export error:', error);
            this.showNotification('error', 'Dışa aktarma başarısız', 'error');
        }
    }

    importLoadingSettings(event) {
        try {
            const file = event.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (e) => {
                try {
                    const settings = JSON.parse(e.target.result);
                    this.applyLoadingSettings(settings);
                    this.showNotification('success', 'Ayarlar içe aktarıldı', 'success');
                } catch (error) {
                    this.showNotification('error', 'Geçersiz dosya formatı', 'error');
                }
            };
            reader.readAsText(file);
        } catch (error) {
            console.error('Import error:', error);
            this.showNotification('error', 'İçe aktarma başarısız', 'error');
        }
    }

    testLoadingScreen() {
        this.showLoading(this.translate('testing_loading_screen'));
        setTimeout(() => {
            this.hideLoading();
        }, 3000);
    }

    applyLoadingScreenCustomization() {
        const settings = this.config.loadingSettings;
        if (!settings) return;

        const overlay = document.getElementById('loadingOverlay');
        const content = document.querySelector('.loading-content');
        const spinner = document.querySelector('.loading-spinner');
        const ring = document.querySelector('.spinner-ring');
        const text = document.querySelector('.loading-text');

        if (!overlay || !content || !spinner || !ring || !text) return;

        if (settings.bgColor) {
            const rgb = this.hexToRgb(settings.bgColor);
            const opacity = settings.bgOpacity || 95;
            overlay.style.background = `rgba(${rgb}, ${opacity / 100})`;
        }

        if (settings.blurEffect !== undefined) {
            overlay.style.backdropFilter = `blur(${settings.blurEffect}px)`;
        }

        if (settings.bgColor) {
            const rgb = this.hexToRgb(settings.bgColor);
            const opacity = settings.bgOpacity || 95;
            content.style.background = `rgba(${rgb}, ${opacity / 100})`;
        }

        if (settings.spinnerColor) {
            content.style.border = `1px solid ${settings.spinnerColor}40`;
        }

        if (settings.spinnerSize) {
            spinner.style.width = `${settings.spinnerSize}px`;
            spinner.style.height = `${settings.spinnerSize}px`;
        }

        if (settings.spinnerColor) {
            ring.style.borderTop = `${settings.spinnerThickness || 4}px solid ${settings.spinnerColor}`;
            ring.style.borderRight = `${settings.spinnerThickness || 4}px solid ${settings.spinnerColor}30`;
            
            ring.style.setProperty('--spinner-color', settings.spinnerColor);
        }

        if (settings.spinnerSpeed) {
            ring.style.animationDuration = `${settings.spinnerSpeed}s`;
        }

        if (settings.spinnerGlow && settings.spinnerColor) {
            ring.style.filter = `drop-shadow(0 0 10px ${settings.spinnerColor}80)`;
        } else {
            ring.style.filter = 'none';
        }

        if (settings.textColor) {
            text.style.color = settings.textColor;
        }

        if (settings.textSize) {
            text.style.fontSize = `${settings.textSize}px`;
        }

        if (settings.textWeight) {
            text.style.fontWeight = settings.textWeight;
        }

        if (settings.textGlow && settings.textColor) {
            text.style.textShadow = `0 0 10px ${settings.textColor}80`;
        } else {
            text.style.textShadow = 'none';
        }

        if (settings.pulseAnimation) {
            content.style.animation = 'loadingPulse 2s ease-in-out infinite';
        } else {
            content.style.animation = 'none';
        }
    }

    showSteamSetupCheckScreen(steamSetupStatus) {
        console.log('showSteamSetupCheckScreen() fonksiyonu çağrıldı');
        
        // Mevcut Steam setup uyarılarını temizle
        const existingWarnings = document.querySelectorAll('.modal-overlay.steam-setup-warning');
        existingWarnings.forEach(warning => warning.remove());
        
        const modal = document.createElement('div');
        modal.className = 'modal-overlay active steam-setup-warning';
        modal.style.zIndex = '999999';
        modal.style.display = 'flex';
        
        let modalContent = '';
        
        if (!steamSetupStatus.hasSteamPath) {
            // Steam yolu eksik
            modalContent = `
                <div class="modal-container" style="max-width: 600px; text-align: left;">
                    <div class="modal-header" style="border-bottom: 1px solid var(--border-color); padding-bottom: 20px; margin-bottom: 20px;">
                        <div style="display: flex; align-items: center; gap: 15px;">
                            <div style="font-size: 48px;">📁</div>
                            <h2 style="color: var(--text-primary); font-size: 24px; font-weight: 600; margin: 0;">${this.translate('steam_path_required')}</h2>
                        </div>
                    </div>
                    <div class="modal-content">
                        <div style="background: var(--secondary-bg); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; margin-bottom: 25px;">
                            <p style="color: var(--text-primary); font-size: 16px; margin: 0 0 15px 0; line-height: 1.5;">
                                ${this.translate('steam_path_not_set')}
                            </p>
                        </div>
                        
                        <div class="modal-actions" style="display: flex; gap: 15px; justify-content: center;">
                            <button class="action-btn primary" onclick="window.ui.selectSteamPath()" style="
                                background: linear-gradient(135deg, #00d4ff, #0099cc);
                                border: none;
                                color: white;
                                padding: 12px 30px;
                                border-radius: 8px;
                                font-size: 16px;
                                font-weight: 600;
                                cursor: pointer;
                                transition: all 0.3s ease;
                                box-shadow: 0 4px 15px rgba(0, 212, 255, 0.3);
                            " onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 6px 20px rgba(0, 212, 255, 0.4)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 4px 15px rgba(0, 212, 255, 0.3)'">
                                📁 ${this.translate('select_steam_path')}
                            </button>
                        </div>
                    </div>
                </div>
            `;
        } else if (!steamSetupStatus.hasHidDll) {
            // hid.dll eksik
            modalContent = `
                <div class="modal-container" style="max-width: 600px; text-align: left;">
                    <div class="modal-header" style="border-bottom: 1px solid var(--border-color); padding-bottom: 20px; margin-bottom: 20px;">
                        <div style="display: flex; align-items: center; gap: 15px;">
                            <div style="font-size: 48px;">⚠️</div>
                            <h2 style="color: var(--text-primary); font-size: 24px; font-weight: 600; margin: 0;">${this.translate('hid_dll_missing')}</h2>
                        </div>
                    </div>
                    <div class="modal-content">
                        <div style="background: var(--secondary-bg); border: 1px solid var(--border-color); border-radius: 12px; padding: 20px; margin-bottom: 25px;">
                            <p style="color: var(--text-primary); font-size: 16px; margin: 0 0 15px 0; line-height: 1.5;">
                                ${this.translate('hid_dll_not_found_description')}
                            </p>
                        </div>
                        
                        <div style="background: linear-gradient(135deg, rgba(239, 68, 68, 0.1), rgba(220, 38, 38, 0.1)); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 12px; padding: 20px; margin-bottom: 25px;">
                            <div style="display: flex; align-items: flex-start; gap: 12px;">
                                <div style="color: #ef4444; font-size: 20px; margin-top: 2px;">ℹ️</div>
                                <div>
                                    <p style="color: #ef4444; font-size: 14px; font-weight: 600; margin: 0 0 8px 0; text-transform: uppercase; letter-spacing: 0.5px;">
                                        ${this.translate('important_note')}
                                    </p>
                                    <p style="color: var(--text-primary); font-size: 14px; margin: 0 0 8px 0; line-height: 1.6;">
                                        ${this.translate('hid_dll_source_info')}
                                    </p>
                                    <p style="color: var(--text-primary); font-size: 14px; margin: 0 0 8px 0; line-height: 1.6;">
                                        ${this.translate('hid_dll_required_for_games')}
                                    </p>
                                    <p style="color: var(--text-primary); font-size: 14px; margin: 0; line-height: 1.6;">
                                        ${this.translate('hid_dll_manual_option')}
                                    </p>
                                </div>
                            </div>
                        </div>
                        
                        <div class="modal-actions" style="display: flex; gap: 15px; justify-content: center;">
                            <button class="action-btn primary" onclick="window.ui.downloadHidDll()" style="
                                background: linear-gradient(135deg, #00d4ff, #0099cc);
                                border: none;
                                color: white;
                                padding: 12px 30px;
                                border-radius: 8px;
                                font-size: 16px;
                                font-weight: 600;
                                cursor: pointer;
                                transition: all 0.3s ease;
                                box-shadow: 0 4px 15px rgba(0, 212, 255, 0.3);
                            " onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 6px 20px rgba(0, 212, 255, 0.4)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 4px 15px rgba(0, 212, 255, 0.3)'">
                                📥 ${this.translate('download_hid_dll')}
                            </button>
                            <button class="action-btn secondary" onclick="window.ui.closeProgram()" style="
                                background: var(--secondary-bg);
                                border: 1px solid var(--border-color);
                                color: var(--text-primary);
                                padding: 12px 30px;
                                border-radius: 8px;
                                font-size: 16px;
                                font-weight: 600;
                                cursor: pointer;
                                transition: all 0.3s ease;
                            " onmouseover="this.style.background='var(--tertiary-bg)'" onmouseout="this.style.background='var(--secondary-bg)'">
                                ❌ ${this.translate('close_program')}
                            </button>
                        </div>
                    </div>
                </div>
            `;
        }
        
        modal.innerHTML = modalContent;
        console.log('Steam setup kontrol modal\'ı oluşturuldu, DOM\'a ekleniyor...');
        document.body.appendChild(modal);
        console.log('Steam setup kontrol modal\'ı DOM\'a eklendi');
        
        // Modal'ın gerçekten eklendiğini kontrol et
        const addedModal = document.querySelector('.modal-overlay.steam-setup-warning');
        if (addedModal) {
            console.log('✅ Steam setup kontrol modal\'ı DOM\'da bulundu');
            console.log('Modal style:', addedModal.style.cssText);
            console.log('Modal display:', window.getComputedStyle(addedModal).display);
            console.log('Modal visibility:', window.getComputedStyle(addedModal).visibility);
            console.log('Modal z-index:', window.getComputedStyle(addedModal).zIndex);
        } else {
            console.log('❌ Steam setup kontrol modal\'ı DOM\'da bulunamadı');
        }
    }
    
}

window.testZipExtraction = (zipPath, targetDir) => {
  return ui.testZipExtraction(zipPath, targetDir);
};

window.closeManualInstallInfo = () => {
  ui.closeManualInstallInfo();
};

const ui = new SteamLibraryUI();
window.steamUI = ui;

function renderAllTexts() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    if (key) {
      el.textContent = ui.translate(key);
    }
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    if (key) {
      el.setAttribute('placeholder', ui.translate(key));
    }
  });
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    if (key) {
      el.setAttribute('title', ui.translate(key));
    }
  });
}

const originalSwitchPage = SteamLibraryUI.prototype.switchPage;
SteamLibraryUI.prototype.switchPage = function(page) {
  originalSwitchPage.call(this, page);
  renderAllTexts();
};

window.addEventListener('DOMContentLoaded', () => {
  const oldSelector = document.getElementById('languageSelector');
  if (oldSelector) oldSelector.remove();
  ui.renderSettingsPage();
  renderAllTexts();
});

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

const langToCountry = {
  tr: 'TR', en: 'US', de: 'DE', fr: 'FR', es: 'ES', ru: 'RU', zh: 'CN', ja: 'JP', it: 'IT', pt: 'PT', ko: 'KR', pl: 'PL', az: 'AZ'
};

async function safeSteamFetch(url) {
    await new Promise(r => setTimeout(r, 200));
    try {
        return await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });
    } catch (e) {
        return await fetch(url);
    }
}


