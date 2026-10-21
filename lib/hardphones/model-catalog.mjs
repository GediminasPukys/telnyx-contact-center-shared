// Shared phone artwork catalog. Product imagery is independent of CTI capability.
const POLY_UCS_DOCS = "https://docs.poly.com/bundle/poly-ucs-ag-6-4-5/page/r-ucs-supported-phone-models.html";
const POLY_EDGE_DOCS = "https://docs.poly.com/bundle/poly-edge-e-ag-current/page/r-poly-edge-e-supported-features.html";
const AUDIOCODES_DOCS = "https://www.audiocodes.com/library/technical-documents?productFamilyGroup=1639";
const YEALINK_EOL_DOCS = "https://www.yealink.com/en/products_list_18.html";

export const VENDOR_MODELS = {
  polycom: [
    "VVX 101", "VVX 150", "VVX 201", "VVX 250", "VVX 300", "VVX 301", "VVX 310", "VVX 311", "VVX 350",
    "VVX 400", "VVX 401", "VVX 410", "VVX 411", "VVX 450", "VVX 500", "VVX 501", "VVX 600", "VVX 601",
    "CCX 350", "CCX 400", "CCX 500", "CCX 505", "CCX 600", "CCX 700",
    "Edge E100", "Edge E220", "Edge E300", "Edge E320", "Edge E350", "Edge E400", "Edge E450", "Edge E500", "Edge E550",
    "Edge B10", "Edge B20", "Edge B30", "Rove 20", "Rove 30", "Rove 40",
  ],
  yealink: [
    "T19", "T19P", "T19P E2", "T20P", "T21", "T21P", "T21P E2", "T22P", "T23P", "T23G", "T26P", "T27P", "T27G", "T28P", "T29G",
    "T31P", "T33G", "T32G", "T38G", "T40P", "T40G", "T41P", "T41S", "T42G", "T42S", "T43U", "T46G", "T46S", "T46U",
    "T48G", "T48S", "T48U", "T52S", "T53", "T53W", "T54S", "T54W", "T56A", "T57W", "T58A", "T58V", "T58W",
  ],
  audiocodes: ["405", "405HD", "420HD", "425HD", "430HD", "C430HD", "440HD", "445HD", "450HD", "C450HD"],
};

function polyImage(model) {
  const exactImages = {
    "VVX 101": "/images/hardphones/poly-vvx-101.png",
    "VVX 150": "/images/hardphones/poly-vvx-150.png",
    "VVX 201": "/images/hardphones/poly-vvx-201.png",
    "VVX 250": "/images/hardphones/poly-vvx-250.png",
    "VVX 300": "/images/hardphones/studio-v2/source/poly-vvx-300.png",
    "VVX 311": "/images/hardphones/poly-vvx-311.png",
    "VVX 350": "/images/hardphones/poly-vvx-350.png",
    "VVX 400": "/images/hardphones/poly-vvx-400.png",
    "VVX 411": "/images/hardphones/poly-vvx-411.png",
    "VVX 450": "/images/hardphones/poly-vvx-450.png",
    "VVX 500": "/images/hardphones/poly-vvx-500.png",
    "VVX 601": "/images/hardphones/poly-vvx-601.png",
    "CCX 400": "/images/hardphones/poly-ccx-400.png",
    "CCX 500": "/images/hardphones/poly-ccx-500.png",
    "Edge E220": "/images/hardphones/poly-edge-e220.png",
    "Edge E350": "/images/hardphones/poly-edge-e350.png",
    "Edge E450": "/images/hardphones/poly-edge-e450.png",
  };
  return exactImages[model] || null;
}

function polyDocs(model) {
  return model.startsWith("Edge") ? POLY_EDGE_DOCS : POLY_UCS_DOCS;
}

function yealinkImage(model) {
  const exactImages = {
    T19: "/images/hardphones/yealink-t19.png",
    T19P: "/images/hardphones/yealink-t19p.png",
    "T19P E2": "/images/hardphones/yealink-t19p-e2.png",
    T20P: "/images/hardphones/yealink-t20p.png",
    T21: "/images/hardphones/yealink-t21.png",
    T21P: "/images/hardphones/yealink-t21p.png",
    "T21P E2": "/images/hardphones/yealink-t21p-e2.png",
    T22P: "/images/hardphones/studio-v2/source/yealink-t22p.png",
    T23P: "/images/hardphones/yealink-t23p.png",
    T23G: "/images/hardphones/yealink-t23g.png",
    T26P: "/images/hardphones/yealink-t26p.png",
    T27P: "/images/hardphones/yealink-t27p.png",
    T27G: "/images/hardphones/yealink-t27g.png",
    T28P: "/images/hardphones/yealink-t28p.png",
    T29G: "/images/hardphones/yealink-t29g.png",
    T31P: "/images/hardphones/yealink-t31p.png",
    T32G: "/images/hardphones/yealink-t32g.png",
    T33G: "/images/hardphones/yealink-t33g.png",
    T38G: "/images/hardphones/yealink-t38g.png",
    T40P: "/images/hardphones/yealink-t40p.png",
    T40G: "/images/hardphones/yealink-t40g.png",
    T41P: "/images/hardphones/yealink-t41p.png",
    T41S: "/images/hardphones/yealink-t41s.png",
    T42G: "/images/hardphones/yealink-t42g.png",
    T42S: "/images/hardphones/yealink-t42s.png",
    T43U: "/images/hardphones/yealink-t43u.png",
    T46G: "/images/hardphones/yealink-t46g.png",
    T46S: "/images/hardphones/yealink-t46s.png",
    T46U: "/images/hardphones/yealink-t46u.png",
    T48G: "/images/hardphones/yealink-t48g.png",
    T48S: "/images/hardphones/yealink-t48s.png",
    T48U: "/images/hardphones/yealink-t48u.png",
    T52S: "/images/hardphones/yealink-t52s.png",
    T53W: "/images/hardphones/yealink-t53w.png",
    T54S: "/images/hardphones/yealink-t54s.png",
    T54W: "/images/hardphones/yealink-t54w.png",
    T56A: "/images/hardphones/yealink-t56a.png",
    T57W: "/images/hardphones/yealink-t57w.png",
    T58A: "/images/hardphones/yealink-t58a.png",
    T58V: "/images/hardphones/yealink-t58v.png",
    T58W: "/images/hardphones/yealink-t58w.png",
  };
  return exactImages[model] || null;
}

function yealinkDocs(model) {
  const productDocs = {
    T31P: "https://www.yealink.com/en/product-detail/ip-phone-t31p",
    T33G: "https://www.yealink.com/en/product-detail/ip-phone-t33g",
    T43U: "https://www.yealink.com/en/product-detail/ip-phone-t43u",
    T46U: "https://www.yealink.com/en/product-detail/ip-phone-t46u",
    T48U: "https://www.yealink.com/en/product-detail/ip-phone-t48u",
    T53W: "https://www.yealink.com/en/product-detail/ip-phone-t53w",
    T54W: "https://www.yealink.com/en/product-detail/ip-phone-t54w",
    T57W: "https://www.yealink.com/en/product-detail/ip-phone-t57w",
    T58W: "https://www.yealink.com/en/product-detail/ip-phone-t58w",
  };
  return productDocs[model] || YEALINK_EOL_DOCS;
}

export const PHONE_MODEL_CATALOG = {
  polycom: Object.fromEntries(VENDOR_MODELS.polycom.map((model) => [model, { image: polyImage(model), docs: polyDocs(model) }])),
  yealink: Object.fromEntries(VENDOR_MODELS.yealink.map((model) => [model, { image: yealinkImage(model), docs: yealinkDocs(model) }])),
  audiocodes: {
    "405": { image: "/images/hardphones/audiocodes-405.png", docs: AUDIOCODES_DOCS },
    "405HD": { image: "/images/hardphones/audiocodes-405hd.png", docs: "https://www.audiocodes.com/products/ip-phones/405hd-ip-phone" },
    "420HD": { image: "/images/hardphones/studio-v2/source/audiocodes-420hd.png", docs: AUDIOCODES_DOCS },
    "425HD": { image: "/images/hardphones/audiocodes-425hd.png", docs: "https://www.audiocodes.com/products/ip-phones/425hd-ip-phone" },
    "430HD": { image: "/images/hardphones/audiocodes-430hd.png", docs: AUDIOCODES_DOCS },
    "C430HD": { image: "/images/hardphones/audiocodes-c430hd.png", docs: "https://www.audiocodes.com/products/ip-phones/c430hd-ip-phone" },
    "440HD": { image: "/images/hardphones/studio-v2/source/audiocodes-440hd.png", docs: AUDIOCODES_DOCS },
    "445HD": { image: "/images/hardphones/audiocodes-445hd.png", docs: "https://www.audiocodes.com/products/ip-phones/445hd-ip-phone" },
    "450HD": { image: "/images/hardphones/audiocodes-450hd.png", docs: AUDIOCODES_DOCS },
    "C450HD": { image: "/images/hardphones/audiocodes-c450hd.png", docs: "https://www.audiocodes.com/products/ip-phones/c450hd-ip-phone" },
  },
};

const normalize = value => String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
export function modelCatalogEntry(vendor, model) {
  const vendorKey = ["poly", "polycom", "hp poly"].includes(String(vendor || "").toLowerCase()) ? "polycom" : normalize(vendor);
  const models = PHONE_MODEL_CATALOG[vendorKey] || {};
  const modelKey = normalize(model).replace(/^(polycom|poly|yealink|audiocodes|sip)/, "");
  const match = Object.keys(models).find(name => normalize(name) === modelKey);
  if (!match) return null;
  const entry = models[match];
  return { ...entry, model: match, vendor: vendorKey,
    thumbnail: entry.image?.replace(/(?:\/source)?\/([^/]+)\.png$/, "/thumbnails/$1.webp") || null,
    preview: entry.image?.replace(/(?:\/source)?\/([^/]+)\.png$/, "/previews/$1.webp") || null,
  };
}
