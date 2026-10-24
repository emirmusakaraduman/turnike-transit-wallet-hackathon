# Turnike: 3 dakikalık demo akışı

Her şey yerelde çalışır (Vercel ve harici cüzdan yok). Sözleşme Monad Testnet'te:
`0x5f3b429352f991f3b3bcc265b2f85bfba750c593`.

## Başlamadan önce (5 dakika önce yap)

- [ ] `cd web && npm run dev` çalışıyor (http://localhost:5173). Telefonla da denenecekse bilgisayarın ağ adresiyle aç
      (`npm run dev -- --host`) ve telefon aynı Wi-Fi'da olsun; Gate'i de aynı adresle aç, yoksa QR'lar telefonun
      erişemediği `localhost`'u taşır.
- [ ] **Sponsor cüzdanında MON var:** `FAUCET_PRIVATE_KEY` adresi hem yolcuların gas'ını hem demo yüklemelerini öder.
      Bakiye için: `cast balance <adres> --rpc-url https://rpc-testnet.monadinfra.com --ether` (en az 3 MON).
- [ ] **Telefon cüzdanını önceden hazırla:** telefonda siteyi aç, "Hazır" olana kadar bekle (birkaç saniye). Bakiye
      0.100 MON (₺100,00) görünmeli. Yedek için ikinci bir cihaz/tarayıcı da hazırla.
- [ ] Projektörde Gate'i **anahtarla** aç: `/#/gate?key=<GATE_KEY>` (anahtar `web/.env.local` içinde). "Dönen kod,
      yenisi … sn sonra" yazısını gör.
- [ ] Bir deneme geçişi yap (giriş ve çıkış), sonra Gate sayfasını yenile (sayaçlar sıfırlansın).
- [ ] Dil: sağ üstten TR veya EN seç (jüri İngilizce ise EN).
- [ ] Sistem çalışıyor mu: `cd web && npm run admin -- status` (`paused: false`).

## Akış

**0:00 Sorun (20 sn).** "Başka şehirden gelen biri tek bir yolculuk için kart alıp para yüklemek zorunda. Biz bunu
telefondaki tek cüzdana çevirdik: kart yok, kripto bilgisi yok, gas yok."

**0:20 Giriş (40 sn).** Telefonda Gate'teki **Kızılay** QR'ını okut (Kamerayı aç). Telefonda bilet ekranı: Ankara,
Kızılay. "Giriş yap"a bas.
- Gate'te Kızılay'ın kapısı **açılır** ve akışa satır düşer (kapı yalnızca zincirde onaylanan geçişle açılıyor).
- Telefonda büyük sayı: onaylanma süresi (gas'ı sponsor ödediği için yaklaşık 0,7–1,2 sn) ve altındaki çubuk:
  "12 sn'lik blok".

**1:00 Çıkış ve ücret (30 sn).** **Çayyolu** QR'ını okut, "Çıkış yap". Makbuz: rota şeridi, ücret **₺25,00**
(0.025 MON; taban ₺10 + 3 bölge × ₺5). Telefonda damga çıkar; Gate'te akışa "Çıkış −0.025" satırı düşer ve Ankara
geliri artar. "Fiyat lira cinsinden sabit; MON kuru değişirse ödenen MON değişir, bilet fiyatı değişmez."

**1:30 Aktarma ve başka şehir (30 sn).** Hemen **Kızılay**'dan tekrar gir: "Aktarma indirimi geçerli" yazısı çıkar;
**Ulus**'ta çık: yalnızca ₺5,00 (giriş ücreti yok). Sonra Gate'te **İstanbul** sekmesine geç, **Taksim**'i okut:
"Yeni kart yok, yeni yükleme yok; aynı bakiye." **Levent**'te çık: ₺60,00.

**2:00 Ceza (20 sn).** Bir yolculukta çıkış yapmadan başka istasyonda "Çıkışı unuttun mu? Burada yeni yolculuk
başlat"a bas. Telefonda kırmızı uyarı, Gate'te "Kapı açık, ceza kesildi". (Bakiye en az 0.1 MON olmalı.)

**2:20 Neden Monad (30 sn).** Gate'in alt bölümüne in:
- "Neden Monad": 12 sn'lik blok ile Monad'ın blok süresi yan yana.
- "Paralel yürütme, 16 gelir parçası": "Global sayaç yok; her yolcu kendi adresine göre bir parçaya yazıyor, aynı anda
  gelenler çakışmıyor."
- "Son yük testi": 9 cüzdan aynı anda giriş, aynı anda çıkış: 18 geçiş, 4 blok, blok başına en çok 8.

**2:50 Kapanış (10 sn).** "Sıradaki adımlar: zincir üstünde istasyon imzası, gerçek ödeme sağlayıcısı ve gerçek bir
kur kaynağı (oracle)."

## Göstermelik ekler (süre kalırsa)

- **Bakiye yükle:** "Bakiye yükle" kartında tutarı seç (0.05 / 0.1 / 0.25 / 0.5), "Kartla yükle (demo)": ödeme
  alınmaz, simülasyondur.
- **Cüzdan yedeği:** "Cüzdan yedeği" kartından 12 kelimeyi göster; başka tarayıcıda "Geri yükle" ile aynı bakiye gelir.
- **Operatör konsolu** (`/#/operator`): bekleyen gelir, "Ödeme adresine çek" (gas'ı sponsor öder), ₺ tarifeleri,
  günlük üst sınır, aktarma süresi, yazdırılabilir QR sayfası.
- **Yönetici komutları** (komut satırı): `npm run admin -- pause` ile sistemi durdur, bir giriş dene ("Sistem
  duraklatıldı"), `unpause` ile aç; `rate <wei>` ile kuru değiştir; `refund <operatör> <yolcu> <MON>` ile iade.

## Plan B

- Telefon işlem yapamıyorsa: hazır tutulan ikinci cihaza geç.
- İnternet gidiyorsa: yerelde demo modu (sahte zincir) ve "Yoğunluk" düğmeleri ile 08:00 yoğunluğunu göster:
  `cd web && VITE_TURNIKE_ADDRESS=0x0000000000000000000000000000000000000000 npm run dev`, sonra `#/gate`.
  Bunun simülasyon olduğunu söyle.
- QR okunmuyorsa: Gate'te ekranı büyüt ya da telefonun kamera uygulamasıyla oku; ya da Gate'i anahtarsız aç
  (sabit QR çalışır).
- "Sponsor cüzdanı bitti" hatası: sponsor adresine MON gönder (testnet faucet).

## Muhtemel sorular

- **Gerçek turnike var mı?** Hayır; Gate ekranı onu simüle ediyor. Gerçek bir turnike denetleyicisi de aynı şeyi yapar:
  zincirdeki `TapIn` olayını görünce açar.
- **Neden Monad?** Bir turnike 12 sn blok bekleyemez. Gerçek bir geçiş onayı yaklaşık 0,4 sn (doğrudan işlem) ile
  0,7–1,2 sn (gas'ı sponsorun ödediği imzalı işlem) arasında. Sabah yoğunluğunda çakışmayı azaltmak için gelir 16
  parçaya bölünüyor.
- **Binlerce kişi aynı anda?** Tasarım buna göre (global sayaç yok), ama ölçtüğümüz en büyük test 9 cüzdan. Ayrıca
  sponsorlu işlemler tek bir sponsor cüzdanından, nonce sırasıyla gidiyor; bu bir tavan. Çözüm: sponsor cüzdan havuzu.
- **QR'ı fotoğraflayıp uzaktan giriş yapılamaz mı?** QR 20 sn'de bir değişiyor ve sunucu doğruluyor. Zincir üstünde
  zorunlu değil; istasyon imzası yol haritasında.
- **Turistin kripto cüzdanı yok.** Yolcu hiçbir şey kurmuyor: cüzdan otomatik oluşuyor, gas'ı sponsor ödüyor, bakiye
  (şimdilik simüle) kartla yükleniyor. Gerçek kart ödemesi bir ödeme sağlayıcısı gerektirir.
- **MON dalgalanırsa?** Tarifeler lira cinsinden; sözleşme kurla MON'a çeviriyor. Kur şimdilik elle ayarlanıyor
  (`setRate`), gerçek bir oracle yol haritasında.
- **Cüzdan nerede duruyor?** Tarayıcıda, 12 kelimelik ifadeden türetilmiş. Yedeklenir ve başka cihazda geri yüklenir.
- **Yanlışlıkla ya da kötü niyetle yüksek ücret?** Operatör başına günlük üst sınır, 4 saati aşan yolculukta üst sınır
  ücreti, iade (`refund`) ve sistemi durduran bir anahtar (`pause`) var.
