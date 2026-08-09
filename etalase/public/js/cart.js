// Keranjang disimpan di sessionStorage browser pembeli (bukan di server —
// sesuai scope v1: checkout hanya kirim ke WA, tidak ada order tersimpan).
const Cart = (() => {
  const STORAGE_KEY = "etalase_cart_v1";
  let items = load();

  function load() {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function save() {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    document.dispatchEvent(new CustomEvent("cart:change", { detail: { items } }));
  }

  function add(product, qty = 1) {
    const existing = items.find((i) => i.id === product.id);
    if (existing) {
      existing.qty += qty;
    } else {
      items.push({
        id: product.id,
        name: product.name,
        price: product.price,
        image_key: product.image_key,
        qty,
      });
    }
    save();
  }

  function setQty(id, qty) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    if (qty <= 0) {
      remove(id);
      return;
    }
    item.qty = qty;
    save();
  }

  function remove(id) {
    items = items.filter((i) => i.id !== id);
    save();
  }

  function clear() {
    items = [];
    save();
  }

  function getQty(id) {
    return items.find((i) => i.id === id)?.qty ?? 0;
  }

  function getAll() {
    return [...items];
  }

  function getTotal() {
    return items.reduce((sum, i) => sum + i.price * i.qty, 0);
  }

  function getCount() {
    return items.reduce((sum, i) => sum + i.qty, 0);
  }

  return { add, setQty, remove, clear, getQty, getAll, getTotal, getCount };
})();

function formatRupiah(n) {
  return "Rp" + Math.round(n).toLocaleString("id-ID");
}
