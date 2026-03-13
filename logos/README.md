# Logos & Branding Assets

This folder contains custom branding assets for Hyperset and Superset.

## Structure

```
logos/
├── hyperset-logo.svg          # Main Hyperset logo (light background)
├── hyperset-logo-dark.svg     # Hyperset logo for dark backgrounds
├── hyperset-icon.svg          # Hyperset icon only (for favicon, mobile)
├── favicon.ico                # Browser favicon (32x32, 64x64)
├── apple-touch-icon.png       # iOS home screen icon (180x180)
├── superset-logo.svg          # Superset logo replacement
├── superset-icon.svg          # Superset icon replacement
└── superset-favicon.ico       # Superset favicon replacement
```

## File Formats

- **SVG**: Scalable vector graphics (recommended for logos)
- **ICO**: Multi-resolution favicon (16x16, 32x32, 64x64)
- **PNG**: Raster images with transparency

## Theme Integration

Place your custom logos here and update `theme.json` to reference them:

```json
{
  "logos": {
    "hyperset": {
      "main": "/logos/hyperset-logo.svg",
      "dark": "/logos/hyperset-logo-dark.svg",
      "favicon": "/logos/favicon.ico"
    },
    "superset": {
      "logo": "/logos/superset-logo.svg",
      "favicon": "/logos/superset-favicon.ico"
    }
  }
}
```

## Design Guidelines

### Hyperset Logo
- **Size**: 200x50px viewBox recommended
- **Colors**: Should work with your primary theme color
- **Format**: SVG with transparent background

### Superset Logo
- **Size**: Should match original Superset logo dimensions
- **Location**: Replace in Superset UI header

## Creating Custom Logos

1. Design your logo in vector format (Illustrator, Figma, Inkscape)
2. Export as SVG with transparent background
3. For favicon: Export as PNG in multiple sizes, then convert to ICO
4. Place files in this directory
5. Update paths in `theme.json`

## Sample Files

See `examples/` folder for sample SVG templates.
