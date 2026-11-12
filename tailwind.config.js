/** @type {import('tailwindcss').Config} */
module.exports = {
    darkMode: ["class"],
    // A phone keeps :hover on the last thing tapped, which looks like a stuck highlight (X49).
    future: { hoverOnlyWhenSupported: true },
    content: ["./index.html", "./src/**/*.{ts,tsx,js,jsx}"],
  theme: {
  	extend: {
  		borderRadius: {
  			lg: 'var(--radius)',
  			md: 'calc(var(--radius) - 2px)',
  			sm: 'calc(var(--radius) - 4px)'
  		},
  		colors: {
  			// The game mode's decoration colours, set per mode in src/index.css (X41). A plain var() has no
  			// channels for Tailwind to apply an opacity modifier to, so bg-ui-accent/50 would silently
  			// come out solid: use color-mix in an arbitrary value instead.
  			ui: {
  				accent: {
  					DEFAULT: 'var(--ui-accent)',
  					strong: 'var(--ui-accent-strong)',
  					deep: 'var(--ui-accent-deep)',
  					ink: 'var(--ui-accent-ink)',
  					soft: 'var(--ui-accent-soft)',
  					'soft-end': 'var(--ui-accent-soft-end)',
  					tint: 'var(--ui-accent-tint)',
  					border: 'var(--ui-accent-border)',
  					'border-strong': 'var(--ui-accent-border-strong)',
  					bright: 'var(--ui-accent-bright)',
  					vivid: 'var(--ui-accent-vivid)'
  				},
  				'on-accent': 'var(--ui-on-accent)',
  				'on-accent-muted': 'var(--ui-on-accent-muted)',
  				'picker-surface': 'var(--ui-picker-surface)',
  				start: 'var(--ui-start)',
  				'start-hover': 'var(--ui-start-hover)',
  				'on-start': 'var(--ui-on-start)'
  			},
  			tile: {
  				'manual-start': 'var(--tile-manual-start)',
  				'manual-end': 'var(--tile-manual-end)',
  				'manual-hover': 'var(--tile-manual-hover)',
  				'manual-shadow': 'var(--tile-manual-shadow)',
  				'scan-start': 'var(--tile-scan-start)',
  				'scan-end': 'var(--tile-scan-end)',
  				'scan-hover-start': 'var(--tile-scan-hover-start)',
  				'scan-hover-end': 'var(--tile-scan-hover-end)',
  				'scan-shadow': 'var(--tile-scan-shadow)'
  			},
  			background: 'hsl(var(--background))',
  			foreground: 'hsl(var(--foreground))',
  			card: {
  				DEFAULT: 'hsl(var(--card))',
  				foreground: 'hsl(var(--card-foreground))'
  			},
  			popover: {
  				DEFAULT: 'hsl(var(--popover))',
  				foreground: 'hsl(var(--popover-foreground))'
  			},
  			primary: {
  				DEFAULT: 'hsl(var(--primary))',
  				foreground: 'hsl(var(--primary-foreground))'
  			},
  			secondary: {
  				DEFAULT: 'hsl(var(--secondary))',
  				foreground: 'hsl(var(--secondary-foreground))'
  			},
  			muted: {
  				DEFAULT: 'hsl(var(--muted))',
  				foreground: 'hsl(var(--muted-foreground))'
  			},
  			accent: {
  				DEFAULT: 'hsl(var(--accent))',
  				foreground: 'hsl(var(--accent-foreground))'
  			},
  			destructive: {
  				DEFAULT: 'hsl(var(--destructive))',
  				foreground: 'hsl(var(--destructive-foreground))'
  			},
  			border: 'hsl(var(--border))',
  			input: 'hsl(var(--input))',
  			ring: 'hsl(var(--ring))',
  			chart: {
  				'1': 'hsl(var(--chart-1))',
  				'2': 'hsl(var(--chart-2))',
  				'3': 'hsl(var(--chart-3))',
  				'4': 'hsl(var(--chart-4))',
  				'5': 'hsl(var(--chart-5))'
  			},
  			sidebar: {
  				DEFAULT: 'hsl(var(--sidebar-background))',
  				foreground: 'hsl(var(--sidebar-foreground))',
  				primary: 'hsl(var(--sidebar-primary))',
  				'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
  				accent: 'hsl(var(--sidebar-accent))',
  				'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
  				border: 'hsl(var(--sidebar-border))',
  				ring: 'hsl(var(--sidebar-ring))'
  			}
  		},
  		keyframes: {
  			'accordion-down': {
  				from: {
  					height: '0'
  				},
  				to: {
  					height: 'var(--radix-accordion-content-height)'
  				}
  			},
  			'accordion-up': {
  				from: {
  					height: 'var(--radix-accordion-content-height)'
  				},
  				to: {
  					height: '0'
  				}
  			},
  			// A soft fade in and out, low opacity at its peak (X44).
  			'chat-mute-pulse': {
  				'0%, 100%': {
  					opacity: '0'
  				},
  				'50%': {
  					opacity: '0.6'
  				}
  			},
  			// A ring that grows out from the chat button and fades as it goes, on each tap (X79).
  			'chat-button-pulse': {
  				from: {
  					transform: 'scale(1)',
  					opacity: '0.8'
  				},
  				to: {
  					transform: 'scale(1.9)',
  					opacity: '0'
  				}
  			},
  			'chat-button-fade': {
  				from: {
  					opacity: '0.8'
  				},
  				to: {
  					opacity: '0'
  				}
  			}
  		},
  		animation: {
  			'accordion-down': 'accordion-down 0.2s ease-out',
  			'accordion-up': 'accordion-up 0.2s ease-out',
  			'chat-mute-pulse': 'chat-mute-pulse 2s ease-in-out 3',
  			// Under prefers-reduced-motion: one slow fade of the same ring instead of cycles.
  			'chat-mute-fade': 'chat-mute-pulse 4s ease-in-out 1',
  			'chat-button-pulse': 'chat-button-pulse 0.6s ease-out 1',
  			// Under prefers-reduced-motion: the ring fades where it is, without growing.
  			'chat-button-fade': 'chat-button-fade 0.6s ease-out 1'
  		}
  	}
  },
  plugins: [require("tailwindcss-animate")],
}