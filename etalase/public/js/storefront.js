(() => {
  const state = {
    settings: null,
    categories: [],
    products: [],
    activeCategory: "",
    searchQuery: "",
    searchDebounce: null,
    sortMode: localStorage.getItem("etalase_sort") || "default",
  };

  const el = {
    storeName: document.getElementById("store-name"),
    storeMeta: document.getElementById("store-meta"),
    storeDesc: document.getElementById("store-desc"),
    storeLogo: document.getElementById("store-logo"),
    promoBanner: document.getElementById("promo-banner"),
    promoBannerImage: document.getElementById("promo-banner-image"),
    promoBannerTextRow: document.getElementById("promo-banner-text-row"),
    promoBannerText: document.getElementById("promo-banner-text"),
    searchInput: document.getElementById("search-input"),
    categoryChips: document.getElementById("category-chips"),
    sortSelect: document.getElementById("sort-select"),
    productGrid: document.getElementById("product-grid"),
    emptyState: document.getElementById("empty-state"),
    resultsTitle: document.getElementById("results-title"),
    resultsCount: document.getElementById("results-count"),
    stickyCartBar: document.getElementById("sticky-cart-bar"),
    stickyCartCount: document.getElementById("sticky-cart-count"),
    stickyCartTotal: document.getElementById("sticky-cart-total"),
    stickyCartBtn: document.getElementById("sticky-cart-btn"),
    bottomNav: document.getElementById("bottom-nav"),
    bottomNavCartBadge: document.getElementById("bottom-nav-cart-badge"),
    drawerOverlay: document.getElementById("drawer-overlay"),
    cartDrawer: document.getElementById("cart-drawer"),
    drawerClose: document.getElementById("drawer-close"),
    cartClearBtn: document.getElementById("cart-clear-btn"),
    cartItems: document.getElementById("cart-items"),
    cartTotal: document.getElementById("cart-total"),
    buyerName: document.getElementById("buyer-name"),
    buyerNote: document.getElementById("buyer-note"),
    checkoutBtn: document.getElementById("checkout-btn"),
    heroSection: document.getElementById("hero-section"),
    heroTagline: document.getElementById("hero-tagline"),
    heroMetaRow: document.getElementById("hero-meta-row"),
    heroCta: document.getElementById("hero-cta"),
    pdOverlay: document.getElementById("pd-overlay"),
    pdSheet: document.getElementById("pd-sheet"),
    storeInfoOverlay: document.getElementById("store-info-overlay"),
    storeInfoClose: document.getElementById("store-info-close"),
    storeInfoLogo: document.getElementById("store-info-logo"),
    storeInfoName: document.getElementById("store-info-name"),
    storeInfoMeta: document.getElementById("store-info-meta"),
    storeInfoDesc: document.getElementById("store-info-desc"),
    storeInfoWaBtn: document.getElementById("store-info-wa-btn"),
    toast: document.getElementById("toast"),
  };

  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.toast.classList.remove("show"), 1800);
  }

  async function fetchJSON(url, opts) {
    const res = await fetch(url, opts);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Gagal memuat ${url}`);
    }
    return res.json();
  }

  function imageUrl(key) {
    if (!key) return null;
    // Foto utama produk sekarang bisa berupa URL ABSOLUT (dari domain
    // kasir, lihat produk.gambar_url) atau key relatif di bucket toko
    // sendiri (logo/banner/galeri tambahan yang diupload dari sini).
    if (/^https?:\/\//.test(key)) return key;
    return `/images/${key}`;
  }

  // ---------- Load initial data ----------
  async function loadSettings() {
    try {
      // FIX: fetch dengan cache:'no-store' supaya browser tidak pakai
      // cached response lama. Tanpa ini, update nama toko dari admin
      // tidak langsung terlihat di storefront sampai user hard-refresh.
      const { settings } = await fetchJSON("/api/settings", { cache: "no-store" });
      state.settings = settings;
      document.documentElement.dataset.theme = settings.theme || "default";
      el.storeName.textContent = settings.store_name || "Toko Saya";
      document.title = settings.store_name || "Etalase Toko";

      // FIX: update Open Graph & Twitter Card meta tags secara dinamis
      // supaya saat link di-share via WA/sosmed, preview menampilkan
      // nama & deskripsi toko yang benar (bukan placeholder default HTML).
      const ogTitle = document.getElementById("og-title");
      const ogDesc = document.getElementById("og-description");
      const ogUrl = document.getElementById("og-url");
      const ogImage = document.getElementById("og-image");
      const twTitle = document.getElementById("tw-title");
      const twDesc = document.getElementById("tw-description");
      const twImage = document.getElementById("tw-image");
      const storeName = settings.store_name || "Toko Kami";
      const storeDesc = settings.description || "Lihat produk kami dan pesan langsung lewat WhatsApp.";
      if (ogTitle) ogTitle.content = storeName;
      if (ogDesc) ogDesc.content = storeDesc;
      if (ogUrl) ogUrl.content = location.href;
      if (twTitle) twTitle.content = storeName;
      if (twDesc) twDesc.content = storeDesc;
      // Logo toko jadi og:image kalau ada
      if (settings.logo_key) {
        const logoUrl = /^https?:\/\//.test(settings.logo_key)
          ? settings.logo_key
          : `${location.origin}/images/${settings.logo_key}`;
        if (ogImage) ogImage.content = logoUrl;
        if (twImage) twImage.content = logoUrl;
      }
      const metaParts = [];
      if (settings.operating_hours) metaParts.push(settings.operating_hours);
      if (settings.address) metaParts.push(settings.address);
      el.storeMeta.textContent = metaParts.join(" · ");
      if (settings.description) {
        el.storeDesc.textContent = settings.description;
        el.storeDesc.style.display = "";
      }
      if (settings.logo_key) {
        el.storeLogo.src = imageUrl(settings.logo_key);
        el.storeLogo.style.display = "";
      }
      // Isi modal "Toko" (dibuka lewat bottom nav)
      el.storeInfoName.textContent = settings.store_name || "Toko Saya";
      if (settings.logo_key) {
        el.storeInfoLogo.src = imageUrl(settings.logo_key);
        el.storeInfoLogo.style.display = "";
      }
      el.storeInfoMeta.innerHTML = metaParts.map((t) => `<div>${escapeHtml(t)}</div>`).join("");
      if (settings.description) {
        el.storeInfoDesc.textContent = settings.description;
        el.storeInfoDesc.style.display = "";
      }
      if (settings.wa_number) {
        el.storeInfoWaBtn.href = `https://wa.me/${settings.wa_number}`;
        el.storeInfoWaBtn.style.display = "";
      } else {
        el.storeInfoWaBtn.style.display = "none";
      }
      // Hero section — tampil bila description diisi tapi tidak ada banner image.
      // Memperkenalkan toko dengan tagline + info operasional + CTA scroll ke produk.
      if (settings.description && !settings.banner_image_key) {
        el.heroTagline.textContent = settings.description;
        const metaChips = [];
        if (settings.operating_hours) {
          metaChips.push(`<span class="hero-meta-chip">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
            </svg>${escapeHtml(settings.operating_hours)}</span>`);
        }
        if (settings.address) {
          metaChips.push(`<span class="hero-meta-chip">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 1 1 18 0z"/><circle cx="12" cy="10" r="3"/>
            </svg>${escapeHtml(settings.address)}</span>`);
        }
        if (metaChips.length) el.heroMetaRow.innerHTML = metaChips.join("");
        else el.heroMetaRow.style.display = "none";
        el.heroSection.style.display = "";
        el.heroCta.addEventListener("click", () => {
          document.querySelector(".toolbar")?.scrollIntoView({ behavior: "smooth" });
        });
      }

      const hasBannerImage = !!settings.banner_image_key;
      const hasBannerText = !!(settings.banner_text && settings.banner_text.trim());
      if (hasBannerImage || hasBannerText) {
        el.promoBanner.style.display = "";
        el.promoBanner.classList.toggle("has-image", hasBannerImage);
        if (hasBannerImage) {
          el.promoBannerImage.src = imageUrl(settings.banner_image_key);
          el.promoBannerImage.style.display = "";
        }
        if (hasBannerText) {
          el.promoBannerText.textContent = settings.banner_text.trim();
          el.promoBannerTextRow.style.display = "";
        }
      }
    } catch (e) {
      el.storeName.textContent = "Toko Saya";
    }
  }

  async function loadCategories() {
    const { categories } = await fetchJSON("/api/categories");
    state.categories = categories;
    renderChips();
  }

  async function loadProducts() {
    renderSkeleton();
    const params = new URLSearchParams();
    if (state.searchQuery) params.set("q", state.searchQuery);
    if (state.activeCategory) params.set("category", state.activeCategory);
    params.set("include_sold_out", "1");
    const { products } = await fetchJSON(`/api/products?${params.toString()}`);
    state.products = products;
    renderProducts();
  }

  // ---------- Rendering ----------
  function renderChips() {
    const chips = [{ slug: "", name: "Semua" }, ...state.categories];
    el.categoryChips.innerHTML = chips
      .map((c) => {
        const initial = (c.name || "?").trim().charAt(0).toUpperCase();
        return `<button class="chip ${state.activeCategory === c.slug ? "active" : ""}" data-slug="${c.slug}">
          <span class="chip-icon">${escapeHtml(initial)}</span>
          <span class="chip-label">${escapeHtml(c.name)}</span>
        </button>`;
      })
      .join("");
    el.categoryChips.querySelectorAll(".chip").forEach((btn) => {
      btn.addEventListener("click", () => {
        state.activeCategory = btn.dataset.slug;
        renderChips();
        loadProducts();
        // FIX: sync bottom nav active state dengan pilihan kategori.
        // "Semua" → highlight icon Beranda, kategori spesifik → highlight Kategori.
        setActiveNav(btn.dataset.slug === "" ? "home" : "category");
      });
    });
  }

  function renderSkeleton() {
    el.productGrid.innerHTML = Array.from({ length: 6 })
      .map(
        () => `<div class="product-card"><div class="product-thumb skeleton"></div><div class="product-info"><div class="skeleton" style="height:12px;border-radius:4px;margin-bottom:6px"></div><div class="skeleton" style="height:12px;width:60%;border-radius:4px"></div></div></div>`
      )
      .join("");
    el.emptyState.style.display = "none";
  }

  function getVisibleProducts() {
    // Produk habis selalu disembunyikan dari etalase (tanpa opsi toggle) —
    // pembeli cuma lihat yang benar-benar bisa dipesan.
    let list = state.products.filter((p) => p.status !== "sold_out");
    if (state.sortMode === "price_asc") list = [...list].sort((a, b) => a.price - b.price);
    else if (state.sortMode === "price_desc") list = [...list].sort((a, b) => b.price - a.price);
    else if (state.sortMode === "name_asc") list = [...list].sort((a, b) => a.name.localeCompare(b.name, "id"));
    return list;
  }

  function renderProducts() {
    const products = getVisibleProducts();
    el.resultsTitle.textContent = state.activeCategory
      ? state.categories.find((c) => c.slug === state.activeCategory)?.name || "Produk"
      : "Semua Produk";
    el.resultsCount.textContent = products.length ? `${products.length} produk` : "";

    if (!products.length) {
      el.productGrid.innerHTML = "";
      el.emptyState.style.display = "";
      return;
    }
    el.emptyState.style.display = "none";

    el.productGrid.innerHTML = products.map(productCardHtml).join("");

    el.productGrid.querySelectorAll("[data-open-id]").forEach((node) => {
      node.addEventListener("click", (ev) => {
        if (ev.target.closest("[data-stop-open]")) return;
        openProductDetail(node.dataset.openId);
      });
    });
    el.productGrid.querySelectorAll("[data-add-id]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const product = state.products.find((p) => String(p.id) === btn.dataset.addId);
        Cart.add(product, 1);
        showToast(`${product.name} ditambahkan ke keranjang`);
        renderProducts();
      });
    });
    el.productGrid.querySelectorAll("[data-step]").forEach((btn) => {
      btn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const id = Number(btn.dataset.stepId);
        const delta = Number(btn.dataset.step);
        Cart.setQty(id, Cart.getQty(id) + delta);
        renderProducts();
      });
    });
  }

  function discountPercent(p) {
    if (!p.original_price || p.original_price <= p.price) return 0;
    return Math.round((1 - p.price / p.original_price) * 100);
  }

  function priceHtml(p, priceClass) {
    const pct = discountPercent(p);
    if (!pct) return `<span class="${priceClass}">${formatRupiah(p.price)}</span>`;
    const rowClass = priceClass === "pd-price" ? "price-row pd-price-row" : "price-row";
    return `
      <span class="${rowClass}">
        <span class="${priceClass}">${formatRupiah(p.price)}</span>
        <span class="price-original">${formatRupiah(p.original_price)}</span>
      </span>`;
  }

  function soldText(p) {
    const n = Number(p.sold_count) || 0;
    if (n <= 0) return "";
    return n >= 1000 ? `${(n / 1000).toFixed(1).replace(".0", "")}rb+ terjual` : `${n} terjual`;
  }

  // Threshold terlaris: produk dengan sold_count >= 10 dapat badge emas.
  const TERLARIS_THRESHOLD = 10;

  // SVG placeholder — ikon tag belanja branded, jauh lebih rapi dari teks polos.
  function placeholderSvg(name) {
    return `<div class="placeholder" aria-label="Foto ${escapeHtml(name)} belum tersedia">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4">
        <path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/>
        <line x1="7" y1="7" x2="7.01" y2="7"/>
      </svg>
      <span>Belum ada foto</span>
    </div>`;
  }

  function productCardHtml(p) {
    const qty = Cart.getQty(p.id);
    const soldOut = p.status === "sold_out";
    const img = imageUrl(p.image_key);
    const pct = discountPercent(p);
    const sold = soldText(p);
    const isTerlaris = !soldOut && Number(p.sold_count) >= TERLARIS_THRESHOLD;
    return `
      <div class="product-card" data-open-id="${p.id}">
        <div class="product-thumb">
          ${soldOut ? '<span class="badge-soldout">Habis</span>' : ""}
          ${isTerlaris ? '<span class="badge-terlaris">★ Terlaris</span>' : ""}
          ${pct ? `<span class="badge-discount">-${pct}%</span>` : ""}
          ${img ? `<img src="${img}" alt="${escapeHtml(p.name)}" loading="lazy" />` : placeholderSvg(p.name)}
        </div>
        <div class="product-info">
          ${p.category_name ? `<span class="product-cat">${escapeHtml(p.category_name)}</span>` : ""}
          <span class="product-name">${escapeHtml(p.name)}</span>
          ${priceHtml(p, "product-price")}
          ${sold ? `<span class="product-sold">${sold}</span>` : ""}
          <div data-stop-open>
            ${
              soldOut
                ? `<button class="add-btn" disabled>Stok Habis</button>`
                : qty > 0
                ? `<div class="qty-stepper">
                     <button data-step="-1" data-step-id="${p.id}">−</button>
                     <span class="qty-value">${qty}</span>
                     <button data-step="1" data-step-id="${p.id}">+</button>
                   </div>`
                : `<button class="add-btn" data-add-id="${p.id}">+ Tambah</button>`
            }
          </div>
        </div>
      </div>`;
  }

  function galleryHtml(images) {
    if (images.length <= 1) {
      return images[0] ? `<img class="pd-image" src="${images[0]}" alt="" />` : "";
    }
    return `
      <div class="pd-gallery" id="pd-gallery">
        <div class="pd-gallery-track" id="pd-gallery-track">
          ${images.map((src) => `<img class="pd-gallery-slide" src="${src}" alt="" />`).join("")}
        </div>
        <div class="pd-gallery-dots" id="pd-gallery-dots">
          ${images.map((_, i) => `<span class="pd-gallery-dot ${i === 0 ? "active" : ""}"></span>`).join("")}
        </div>
      </div>`;
  }

  function wireGallery() {
    const track = document.getElementById("pd-gallery-track");
    const dots = document.getElementById("pd-gallery-dots");
    if (!track || !dots) return;
    const dotEls = dots.querySelectorAll(".pd-gallery-dot");
    track.addEventListener("scroll", () => {
      const idx = Math.round(track.scrollLeft / track.clientWidth);
      dotEls.forEach((d, i) => d.classList.toggle("active", i === idx));
    });
  }

  function openProductDetail(id) {
    const p = state.products.find((x) => String(x.id) === String(id));
    if (!p) return;
    const img = imageUrl(p.image_key);
    const sold = soldText(p);
    el.pdSheet.innerHTML = `
      <div id="pd-gallery-wrap">${galleryHtml(img ? [img] : [])}</div>
      <button class="pd-close-btn" id="pd-close-btn" title="Tutup" aria-label="Tutup">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="pd-content">
        <div class="pd-content-top">
          ${p.category_name ? `<span class="product-cat">${escapeHtml(p.category_name)}</span>` : ""}
          <button class="pd-share-btn" id="pd-share-btn" title="Bagikan produk">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.6" y1="13.5" x2="15.4" y2="17.5"/><line x1="15.4" y1="6.5" x2="8.6" y2="10.5"/></svg>
          </button>
        </div>
        <h2>${escapeHtml(p.name)}</h2>
        ${priceHtml(p, "pd-price")}
        <div class="pd-badges-row">
          ${discountPercent(p) ? `<span class="pd-discount-badge">Hemat ${discountPercent(p)}%</span>` : ""}
          ${sold ? `<span class="pd-sold-badge">${sold}</span>` : ""}
        </div>
        ${p.description ? `<p class="pd-desc">${escapeHtml(p.description)}</p>` : ""}
        <div id="pd-action"></div>
      </div>`;
    renderPdAction(p);
    document.getElementById("pd-share-btn").addEventListener("click", () => shareProduct(p));
    document.getElementById("pd-close-btn").addEventListener("click", () => closePdOverlay());
    el.pdOverlay.classList.add("open");
    document.body.style.overflow = "hidden";

    // Ambil galeri foto tambahan di background (tidak menunda tampilan awal).
    fetchJSON(`/api/products/${p.id}`)
      .then(({ product: full }) => {
        const gallery = Array.isArray(full.gallery_images) ? full.gallery_images : [];
        if (!gallery.length) return;
        const allImages = [img, ...gallery.map(imageUrl)].filter(Boolean);
        document.getElementById("pd-gallery-wrap").innerHTML = galleryHtml(allImages);
        wireGallery();
      })
      .catch(() => {});
  }

  // Share ke WhatsApp (atau app lain lewat share sheet native kalau tersedia)
  // TANPA nomor tujuan — biar pembeli pilih sendiri mau kirim ke siapa,
  // beda dari checkout yang otomatis ke nomor toko.
  function shareProduct(p) {
    const storeUrl = window.location.origin;
    const summary = `${p.name}\n${formatRupiah(p.price)}\n\nLihat & pesan di etalase kami:`;
    if (navigator.share) {
      navigator.share({ title: p.name, text: summary, url: storeUrl }).catch(() => {});
      return;
    }
    window.open(`https://wa.me/?text=${encodeURIComponent(`${summary}\n${storeUrl}`)}`, "_blank");
  }

  function renderPdAction(p) {
    const qty = Cart.getQty(p.id);
    const soldOut = p.status === "sold_out";
    const action = document.getElementById("pd-action");
    if (!action) return;
    if (soldOut) {
      action.innerHTML = `<button class="add-btn" disabled style="width:100%;padding:12px">Stok Habis</button>`;
      return;
    }
    action.innerHTML =
      qty > 0
        ? `<div class="qty-stepper" style="max-width:160px">
             <button data-pd-step="-1">−</button>
             <span class="qty-value">${qty}</span>
             <button data-pd-step="1">+</button>
           </div>`
        : `<button class="add-btn" id="pd-add-btn" style="width:100%;padding:12px">+ Tambah ke Keranjang</button>`;

    const addBtn = document.getElementById("pd-add-btn");
    if (addBtn) addBtn.addEventListener("click", () => { Cart.add(p, 1); renderPdAction(p); renderProducts(); showToast(`${p.name} ditambahkan`); });
    action.querySelectorAll("[data-pd-step]").forEach((btn) => {
      btn.addEventListener("click", () => {
        Cart.setQty(p.id, Cart.getQty(p.id) + Number(btn.dataset.pdStep));
        renderPdAction(p);
        renderProducts();
      });
    });
  }

  function closePdOverlay() {
    el.pdOverlay.classList.remove("open");
    document.body.style.overflow = "";
  }
  el.pdOverlay.addEventListener("click", (e) => {
    if (e.target === el.pdOverlay) closePdOverlay();
  });

  // ---------- Cart drawer ----------
  function renderCart() {
    const items = Cart.getAll();
    const count = Cart.getCount();

    el.bottomNavCartBadge.textContent = count;
    el.bottomNavCartBadge.style.display = count > 0 ? "" : "none";

    el.stickyCartBar.style.display = count > 0 ? "flex" : "none";
    el.stickyCartCount.textContent = `${count} item`;
    el.stickyCartTotal.textContent = formatRupiah(Cart.getTotal());

    el.cartTotal.textContent = formatRupiah(Cart.getTotal());
    el.checkoutBtn.disabled = count === 0;

    el.cartClearBtn.style.display = count > 0 ? "" : "none";

    if (!items.length) {
      el.cartItems.innerHTML = `<p style="color:var(--ink-soft);font-size:13.5px;text-align:center;padding:30px 0">Keranjang masih kosong.</p>`;
      return;
    }
    el.cartItems.innerHTML = items
      .map(
        (i) => `
      <div class="cart-item">
        ${i.image_key ? `<img src="${imageUrl(i.image_key)}" alt="" />` : `<div style="width:56px;height:56px;border-radius:8px;background:var(--paper-dim)"></div>`}
        <div class="cart-item-info">
          <div class="cart-item-name">${escapeHtml(i.name)}</div>
          <div class="cart-item-price">${i.qty} x ${formatRupiah(i.price)} = ${formatRupiah(i.qty * i.price)}</div>
          <button class="cart-item-remove" data-remove-id="${i.id}">Hapus</button>
        </div>
        <div class="qty-stepper" style="min-height:44px">
          <button data-cart-step="-1" data-cart-id="${i.id}">−</button>
          <span class="qty-value" style="min-width:20px">${i.qty}</span>
          <button data-cart-step="1" data-cart-id="${i.id}">+</button>
        </div>
      </div>`
      )
      .join("");

    el.cartItems.querySelectorAll("[data-remove-id]").forEach((btn) =>
      btn.addEventListener("click", () => { Cart.remove(Number(btn.dataset.removeId)); renderProducts(); })
    );
    el.cartItems.querySelectorAll("[data-cart-step]").forEach((btn) =>
      btn.addEventListener("click", () => {
        const id = Number(btn.dataset.cartId);
        Cart.setQty(id, Cart.getQty(id) + Number(btn.dataset.cartStep));
        renderProducts();
      })
    );
  }

  document.addEventListener("cart:change", renderCart);

  // Hapus semua isi keranjang — perlu 2x ketuk dalam 3 detik supaya tidak
  // kepencet tidak sengaja (tanpa native confirm() yang kaku).
  let clearArmed = false;
  let clearTimer = null;
  el.cartClearBtn.addEventListener("click", () => {
    if (!clearArmed) {
      clearArmed = true;
      el.cartClearBtn.textContent = "Ketuk lagi untuk hapus";
      el.cartClearBtn.classList.add("confirming");
      clearTimeout(clearTimer);
      clearTimer = setTimeout(() => {
        clearArmed = false;
        el.cartClearBtn.textContent = "Hapus Semua";
        el.cartClearBtn.classList.remove("confirming");
      }, 3000);
      return;
    }
    clearTimeout(clearTimer);
    clearArmed = false;
    el.cartClearBtn.textContent = "Hapus Semua";
    el.cartClearBtn.classList.remove("confirming");
    Cart.clear();
    renderProducts();
    showToast("Keranjang dikosongkan");
  });

  function openDrawer() {
    el.drawerOverlay.classList.add("open");
    el.cartDrawer.classList.add("open");
    // FIX: tanpa scroll lock, background page masih bisa di-scroll di iOS
    // saat drawer terbuka — user scroll background tanpa sengaja.
    document.body.style.overflow = "hidden";
    renderCart();
  }
  function closeDrawer() {
    el.drawerOverlay.classList.remove("open");
    el.cartDrawer.classList.remove("open");
    document.body.style.overflow = "";
  }
  el.stickyCartBtn.addEventListener("click", openDrawer);
  el.drawerClose.addEventListener("click", closeDrawer);
  el.drawerOverlay.addEventListener("click", closeDrawer);

  // ---------- Bottom nav ----------
  function setActiveNav(name) {
    el.bottomNav.querySelectorAll(".bottom-nav-item").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.nav === name);
    });
  }
  el.bottomNav.querySelectorAll(".bottom-nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const nav = btn.dataset.nav;
      if (nav === "home") {
        state.activeCategory = "";
        el.searchInput.value = "";
        state.searchQuery = "";
        renderChips();
        loadProducts();
        window.scrollTo({ top: 0, behavior: "smooth" });
        setActiveNav("home");
      } else if (nav === "category") {
        el.categoryChips.scrollIntoView({ behavior: "smooth", block: "center" });
        setActiveNav("category");
        // FIX: jangan reset active nav ke "home" setelah timeout.
        // User tap Kategori → filter produk aktif → nav Kategori harus tetap highlight.
        // Reset hanya terjadi kalau user navigasi ke tab lain secara eksplisit.
      } else if (nav === "cart") {
        openDrawer();
      } else if (nav === "store") {
        el.storeInfoOverlay.classList.add("open");
        document.body.style.overflow = "hidden";
      }
    });
  });
  function closeStoreInfo() {
    el.storeInfoOverlay.classList.remove("open");
    document.body.style.overflow = "";
  }
  el.storeInfoClose.addEventListener("click", closeStoreInfo);
  el.storeInfoOverlay.addEventListener("click", (e) => {
    if (e.target === el.storeInfoOverlay) closeStoreInfo();
  });

  // ---------- Checkout ----------
  function buildWhatsAppMessage() {
    const items = Cart.getAll();
    const template =
      state.settings?.checkout_message_template ||
      "Halo, saya mau pesan:\n{items}\n\nTotal: {total}\nNama: {nama}\nCatatan: {catatan}";

    const itemLines = items
      .map((i, idx) => `${idx + 1}. ${i.name} x${i.qty} - ${formatRupiah(i.price * i.qty)}`)
      .join("\n");

    const nama = el.buyerName.value.trim() || "-";
    const catatan = el.buyerNote.value.trim() || "-";

    return template
      .replaceAll("{items}", itemLines)
      .replaceAll("{total}", formatRupiah(Cart.getTotal()))
      .replaceAll("{nama}", nama)
      .replaceAll("{catatan}", catatan);
  }

  el.checkoutBtn.addEventListener("click", () => {
    if (!Cart.getCount()) return;
    if (!el.buyerName.value.trim()) {
      showToast("Isi nama Anda dulu ya");
      el.buyerName.focus();
      return;
    }
    const waNumber = state.settings?.wa_number;
    if (!waNumber) {
      showToast("Nomor WA toko belum diatur");
      return;
    }
    const message = buildWhatsAppMessage();
    const url = `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`;

    // Log riwayat pesanan (fire-and-forget) — kalau gagal (mis. offline),
    // checkout tetap lanjut, ini cuma pencatatan untuk admin.
    const items = Cart.getAll();
    fetch("/api/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        buyer_name: el.buyerName.value.trim(),
        buyer_note: el.buyerNote.value.trim() || null,
        items: items.map((i) => ({ id: i.id, name: i.name, price: i.price, qty: i.qty })),
        total: Cart.getTotal(),
      }),
    }).catch(() => {});

    window.open(url, "_blank");
  });

  // ---------- Search ----------
  el.searchInput.addEventListener("input", () => {
    clearTimeout(state.searchDebounce);
    state.searchDebounce = setTimeout(() => {
      state.searchQuery = el.searchInput.value.trim();
      loadProducts();
    }, 300);
  });

  // ---------- Sort & filter tampilan ----------
  el.sortSelect.addEventListener("change", () => {
    state.sortMode = el.sortSelect.value;
    localStorage.setItem("etalase_sort", state.sortMode);
    renderProducts();
  });

  function escapeHtml(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---------- Init ----------
  (async function init() {
    el.sortSelect.value = state.sortMode;
    await Promise.all([loadSettings(), loadCategories()]);
    await loadProducts();
    renderCart();
  })();
})();
