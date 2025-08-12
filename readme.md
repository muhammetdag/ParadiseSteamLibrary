# Paradise Steam Library

Modern Steam Kütüphane Yöneticisi - Gelişmiş özellikler ve kullanıcı dostu arayüz ile Steam oyunlarınızı yönetin.

## 🚀 Özellikler

### 📚 Steam Kütüphane Yönetimi
- **Oyun Ekleme**: Steam kütüphanenize oyun ekleyin
- **DLC Desteği**: Oyunlarla birlikte DLC'leri de ekleyin
- **Kütüphane Görüntüleme**: Mevcut oyunlarınızı görüntüleyin
- **Oyun Silme**: Kütüphaneden oyunları kaldırın

### 🌐 Online Oyun Sistemi
- **Online Pass**: Online oyunları indirin ve kurun
- **Steam API Entegrasyonu**: Gerçek oyun isimleri ve görselleri
- **Otomatik Görsel**: Steam CDN'den otomatik görsel çekme
- **Akıllı Fallback**: API hatası durumunda yedek sistem

### 🎮 Manuel Oyun Kurulumu
- **ZIP Dosyası Desteği**: Manuel ZIP dosyalarını kurun
- **Otomatik Algılama**: Oyun ID'sini otomatik algılar
- **Steam Entegrasyonu**: Steam kütüphanesine otomatik ekleme

### 🤖 Yerleşik AI Sohbet
- Uygulamanın sağ alt köşesinde AI sohbet yardımcısı.
- Discord ve harici yerler yerine, uygulama içerisinden destek alabilirsiniz.

### 🎨 Modern Arayüz
- **Dark Theme**: Göz yormayan koyu tema
- **Responsive Design**: Tüm ekran boyutlarına uyumlu
- **Animasyonlar**: Akıcı kullanıcı deneyimi
- **Türkçe Arayüz**: Tam Türkçe desteği

### 🔧 Gelişmiş Özellikler
- **Discord RPC**: Discord'da oyun durumunu göster
- **Steam Restart**: Steam'i otomatik yeniden başlat
- **Arama Sistemi**: Oyunlarda hızlı arama
- **Kategoriler**: Oyunları kategorilere göre filtrele

## 📦 Kurulum

### Gereksinimler
- Node.js 16+ 
- npm veya yarn
- Windows 10/11

### Geliştirme Ortamı
```bash
# Bağımlılıkları yükle
npm install

# Geliştirme modunda çalıştır
npm run dev

# Normal modda çalıştır
npm start
```

### Portable Build
```bash
# Portable exe oluştur
npm run build-portable

# Tüm Windows build'leri
npm run build-win

# Sadece installer
npm run build
```

## [v2.0.2] - 12.08.2025

# Paradise Steam Library v2.0.2

## 🖼 Arayüz Güncellemesi
- Tüm sayfalarda tasarım düzenlemesi yapıldı.
- Arayüz daha kompakt hale getirildi.
- İkonlar düzeltildi.
- Daha performanslı bir arayüz elde edildi.


## 🎮 Yeni Özellikler

### 🔐 Yeni OnlinePass Ssitemi
- Tamamen yenilenmiş OnlinePass sistemi
- 1400'den fazla online oyun desteği
- Manuel kurulum ile sorunsuz oynama desteği

### 🤖 Yerleşik AI Sohbet
- Uygulamanın sağ alt köşesine AI sohbet yardımcısı eklendi.
- Discord ve harici yerler yerine, uygulama içerisinden destek alabilirsiniz.
- Sohbet geçmişi yerel oturumda tutulur ve performans için son 50 mesaj saklanır.

### 🌍 Çok Dilli Sistem Bilgilendirmesi
- Azerbaycan dili için dil desteği getirildi.
- OnlinePass ve manuel kurulum sayfaları için dil desteği entegre edildi.

## 🔧 Teknik İyileştirmeler

### Backend
- API erişim sorunu yaşanmaması adına subdomain'e aktarıldı.
 - AI proxy servisi eklendi ve CORS uyumlu hale getirildi.


---

## 🤝 Katkıda Bulunma

1. Fork yapın
2. Feature branch oluşturun (`git checkout -b feature/amazing-feature`)
3. Commit yapın (`git commit -m 'Add amazing feature'`)
4. Push yapın (`git push origin feature/amazing-feature`)
5. Pull Request açın

## 📄 Lisans

Bu proje MIT lisansı altında lisanslanmıştır. Detaylar için `LICENSE` dosyasına bakın.

## 👨‍💻 Geliştirici

**Muhammet DAĞ** - Modern Steam kütüphane yönetimi için geliştirilmiştir.

---

⭐ Bu projeyi beğendiyseniz yıldız vermeyi unutmayın! 
