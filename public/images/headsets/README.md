# Headset artwork

Generated with the built-in `image_gen` tool on 2026-10-19 and 2026-10-20. These are product illustrations based on visual references, not manufacturer photographs or a hardware compatibility claim.

- `source/`: original transparent PNG renders.
- `light/` and `dark/`: 320 × 320 transparent WebP assets used by the application.
- `catalog.html`: side-by-side theme preview for all 19 catalog entries.

Both theme directories intentionally contain the same transparent product render. The `HeadsetArtwork` component supplies a solid neutral light or dark background. This avoids product geometry changing when switching themes. The originals were resized and encoded with Sharp; no generated product geometry was edited in post-processing. Unused manufacturer images from `epos/` have been removed. The application uses only the new artwork.

## Models and references

| Illustration | Reference |
| --- | --- |
| Sennheiser SC230 USB CTRL II | [SC230 reference photograph](https://www.best4systems.de/media/catalog/product/cache/7f9fe02aa86503e0bfcc054c1c99973a/s/e/sennheiser-sc230-usb-ctrl-vl_4.jpg); headset geometry only, without inline controller |
| EPOS / Sennheiser MB Pro 2 | Historical repository reference (removed) `epos/mb-pro-2.png` |
| EPOS BTD 800 USB | Historical repository reference (removed) `epos/btd-800-usb.png` |
| Jabra Evolve2 65 Stereo, black | [Jabra product reference](https://www.jabra.com/supportpages/jabra-evolve2-65) |
| Poly Voyager Focus 2 | [HP product reference](https://jp.ext.hp.com/accessories/business/poly/voyager_focus2_chs/) |
| jabra-pro-930-mono | [Visual reference](https://cdn11.bigcommerce.com/s-u3uxlvxq3h/images/stencil/original/products/3591/20945/930-65-509-105-2__87038.1584427640.jpg?c=1) |
| jabra-evolve-20-stereo | [Visual reference](https://images-na.ssl-images-amazon.com/images/I/41pA98%2BrdEL.jpg) |
| jabra-evolve-40-stereo | [Visual reference](https://rukminim2.flixcart.com/image/832/832/xif0q/headphone/y/a/4/evolve-40-uc-wired-over-the-ear-headset-bluetooth-headset-black-original-imagvcthzrqtmwgx.jpeg?crop=false&q=70) |
| jabra-engage-65-stereo | [Visual reference](https://images.kaina24.lt/8556/46/ausines-jabra-engage-65-stereo-juodos.jpg) |
| epos-sc260-usb-ii | [Visual reference](https://www.speedcomputers.biz/wa-data/public/shop/products/20/85/198520/images/331026/331026.750x0.jpg) |
| epos-sc660-usb | [Visual reference](https://www.bircom.com/cdn/shop/files/IMPACTSC660USBML_B2_3Dview_connectivity_1000x1000_46a056df-79ff-4c79-88f4-7837911f9935.webp?v=1694691130) |
| epos-impact-860 | [Visual reference](https://headsetadvisor.com/cdn/shop/files/Epos_Impact_860.png?v=1721058474&width=1600) |
| epos-adapt-260 | [Visual reference](https://cdn.cs.1worldsync.com/57/bf/57bf6773-55dc-42fc-9476-29bcdac1bd4c.jpg) |
| poly-blackwire-3220 | [Visual reference](https://smarthold.cl/cdn/shop/files/Audifono_Poly_3220_Stereo_Usb_8X228A6.png?v=1783140090&width=416) |
| poly-blackwire-5220 | [Visual reference](https://product.hstatic.net/200000521905/product/8372c88ff9b64b87aacc3e6f01f5f0be_ba57f5624e214216be2872b3fb7cd918_grande.png) |
| poly-voyager-5200 | [Visual reference](https://media.power-cdn.net/images/h-e93d37c756163df628c5c17f27f368fb/products/3265645/3265645_3_1200x1200_w_g.jpg) |
| poly-savi-8220 | [Visual reference](https://cdn.cs.1worldsync.com/f1/8a/f18a856d-7561-4af3-af7a-ee07eec2e466.jpg) |

The 2026-10-20 additions are a representative office/contact-center selection from Jabra, EPOS/Sennheiser and Poly, not a verified sales-ranking list. Evolve 20/40 and Engage 65 renders represent stereo models only. PRO 930 uses the mono render and rejects explicit Duo/Stereo labels. ANC and visually different generations are not silently substituted. Public visual references are listed above.

The BT600 USB-A and original Voyager Focus UC (B825) illustrations were added after the physical-device session. The USB-C adapter and Focus 2 are different products. BT600 alone does not identify its paired headset: the user can explicitly choose Voyager Focus UC in the advanced panel.

- [BT600 USB-A reference](https://hp.widen.net/content/jh4yya7ffv/png/jh4yya7ffv.png?color=ffffff00&dpi=72&h=600&w=800)
- [Voyager Focus UC reference](https://www.cmp-net.com/shop/img/produkte/43992b.jpg)

## Extending the catalog


Match named product fields with token boundaries and vendor filtering. An explicit catalog product-number whitelist preserves BTD 800 dongle identification. Do not identify a headset from its serial number or assume which headset is paired to a USB dongle. Ambiguous or unknown variants retain the neutral icon. In particular, the stereo Evolve2 65 artwork requires an explicit stereo model label; it must not represent a mono or Flex variant. Catalog matching never enables call-control capabilities.
