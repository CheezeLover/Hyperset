# Theming & Branding Guide

Hyperset supports comprehensive theming through a single `theme.json` file that controls both the Hyperset Portal and Superset interfaces.

## Quick Start

1. **Edit `theme.json`** - Configure your colors and branding
2. **Add logos to `logos/`** - Place your custom SVG/PNG files
3. **Restart** - Run `./setup_podman.sh` to apply

## Configuration

### `theme.json` Structure

```json
{
  "name": "Your Theme Name",
  "hyperset": {
    "colors": {
      "primary": "#FF6B35",
      "secondary": "#2D3748",
      "background": "#F7FAFC",
      "surface": "#FFFFFF",
      "text": "#1A202C"
    }
  },
  "superset": {
    "enabled": true,
    "colors": {
      "primary": "#FF6B35",
      "secondary": "#2D3748"
    }
  },
  "logos": {
    "hyperset": {
      "main": "/logos/hyperset-logo.svg",
      "favicon": "/logos/favicon.ico"
    },
    "superset": {
      "logo": "/logos/superset-logo.svg"
    }
  }
}
```

### Color Properties

#### Hyperset Portal Colors

| Property | Description | Default |
|----------|-------------|---------|
| `primary` | Main brand color | `#FF6B35` |
| `primaryDark` | Darker variant | `#E85A2D` |
| `primaryLight` | Lighter variant | `#FF8A5C` |
| `secondary` | Secondary/accent | `#2D3748` |
| `background` | Page background | `#F7FAFC` |
| `surface` | Card/surface background | `#FFFFFF` |
| `text` | Primary text | `#1A202C` |
| `textMuted` | Secondary text | `#718096` |
| `border` | Borders and dividers | `#E2E8F0` |
| `success` | Success states | `#48BB78` |
| `warning` | Warning states | `#ED8936` |
| `error` | Error states | `#F56565` |
| `info` | Info states | `#4299E1` |

#### Superset Colors

When `DEPLOY_WITH_SUPERSET=true`, these control the Superset UI:

| Property | Description |
|----------|-------------|
| `superset.colors.primary` | Primary buttons, links |
| `superset.colors.secondary` | Secondary elements |
| `superset.colors.grayscale` | Gray palette for UI |

## Logo Customization

### Logo Files

Place files in the `logos/` folder:

```
logos/
├── hyperset-logo.svg          # Main logo (light bg)
├── hyperset-logo-dark.svg     # Dark variant
├── hyperset-icon.svg          # Icon only
├── favicon.ico                # Browser favicon
├── apple-touch-icon.png       # iOS icon (180x180)
├── superset-logo.svg          # Superset replacement
└── superset-icon.svg          # Superset icon
```

### SVG Logo Template

Create your logo in any vector editor (Figma, Illustrator, Inkscape):

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 50">
  <!-- Your logo design here -->
  <text x="50" y="30" font-family="Inter" fill="#FF6B35">
    Your Brand
  </text>
</svg>
```

## Conditional Theming

### When `DEPLOY_WITH_SUPERSET=false`

Only Portal theming is applied. Superset sections in `theme.json` are ignored:

```json
{
  "superset": {
    "enabled": false
  }
}
```

### When `DEPLOY_WITH_SUPERSET=true`

Both Portal and Superset theming are applied automatically.

## Example: Orange Theme

```json
{
  "name": "Orange Corporate",
  "hyperset": {
    "colors": {
      "primary": "#FF6B35",
      "primaryDark": "#E85A2D",
      "primaryLight": "#FF8A5C",
      "secondary": "#2D3748",
      "background": "#FFF8F5",
      "surface": "#FFFFFF",
      "text": "#1A202C",
      "textMuted": "#718096",
      "border": "#F0E0D8"
    }
  },
  "superset": {
    "enabled": true,
    "colors": {
      "primary": "#FF6B35",
      "secondary": "#2D3748"
    }
  }
}
```

## Advanced: Custom CSS

For advanced styling, create a custom CSS file and mount it:

```bash
# In podman-compose.superset.yml volumes:
- ./custom.css:/app/static/assets/custom.css:Z
```

Then add to `superset_config_docker.py`:
```python
EXTRA_CSS = "/static/assets/custom.css"
```

## Troubleshooting

### Changes Not Applied

1. Restart containers: `podman-compose restart`
2. Clear browser cache
3. Check logs: `podman logs hyperset-portal`

### Superset Logo Not Changing

Verify:
- `DEPLOY_WITH_SUPERSET=true` in `.env`
- Logo file exists in `logos/` folder
- Path matches in `theme.json`

### Colors Look Wrong

- Check color format: Use hex codes (#RRGGBB)
- Verify JSON syntax (no trailing commas)
- Ensure theme.json is valid JSON: `cat theme.json | python -m json.tool`

## Branding Checklist

- [ ] Edit `theme.json` with your colors
- [ ] Create logo SVG files
- [ ] Update logo paths in `theme.json`
- [ ] Place logos in `logos/` folder
- [ ] Test on both light and dark backgrounds
- [ ] Verify favicon displays correctly
- [ ] Check mobile responsiveness
