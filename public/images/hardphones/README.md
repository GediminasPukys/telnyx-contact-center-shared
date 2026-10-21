# Shared phone artwork

The four phones currently in the user's inventory use new reference-based
studio illustrations from `studio-v2/`: AudioCodes 420HD and 440HD, Polycom
VVX 300, and Yealink T22P. They replace the old photos in **every** consumer of
`StationArtwork`, including the inventory, detail panel, login and switch picker.
The versioned paths prevent old browser-cached thumbnails from being reused.

- `studio-v2/source/`: original transparent PNG outputs from built-in `image_gen`.
- `studio-v2/thumbnails/`: 160 × 160 WebP, quality 92, full alpha quality.
- `studio-v2/previews/`: 640 × 480 WebP, quality 94, full alpha quality.

These are generated product illustrations based on each model's reference image,
not manufacturer photographs. Their presence does not certify CTI compatibility.

## Remaining catalog models

The existing model PNGs in this directory are the source images. The shared
catalog in `lib/hardphones/model-catalog.mjs` maps exact models to those images
and to the optimized WebP variants:

- `thumbnails/`: 96 × 96, contained with transparent padding, WebP quality 85.
- `previews/`: 320 × 240, contained with transparent padding, WebP quality 90.

There are 64 remaining catalog image pairs. The four replaced model photographs
and their old WebP pairs have been removed, along with unused JPEG duplicates. `StationArtwork` is used by provisioning inventory,
the login selector and the change-phone modal. Model
spelling aliases share one asset; a model without an exact image uses a generic
device icon rather than displaying a different handset.

Manufacturer logos remain in `logos/`; `PhoneVendorBadge` gives them a consistent
neutral chip, optical bounds and a category color dot in both UI themes.
