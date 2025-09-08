const STYLESHEET = `
* {
	box-sizing: border-box;
}

body,
html {
	margin: 0;
	padding: 0;
	width: 100%;
	min-height: 100%;
}

body {
	padding: 2vh;
	font-size: 2.2vh;
}

html {
	background-size: auto 100%;
	background-size: cover;
	background-position: center center;
	background-repeat: no-repeat;
	box-shadow: inset 0 0 0 2000px rgb(0 0 0 / 60%);
}

body {
	/* Use a single-column flex layout to avoid unintended side-by-side columns */
	display: flex;
	flex-direction: column;
	align-items: center;
	font-family: 'Open Sans', Arial, sans-serif;
	color: white;
}

h1 {
	font-size: 4.5vh;
	font-weight: 700;
}

h2 {
	font-size: 2.2vh;
	font-weight: normal;
	font-style: italic;
	opacity: 0.8;
}

h3 {
	font-size: 2.2vh;
}

h1,
h2,
h3,
p {
	margin: 0;
	text-shadow: 0 0 1vh rgba(0, 0, 0, 0.15);
}

p {
	font-size: 1.75vh;
}

ul {
	font-size: 1.75vh;
	margin: 0;
	margin-top: 1vh;
	padding-left: 3vh;
}

a {
	color: white
}

a.install-link {
	text-decoration: none
}

button {
	border: 0;
	outline: 0;
	color: white;
	background: #8A5AAB;
	padding: 1.2vh 3.5vh;
	margin: auto;
	text-align: center;
	font-family: 'Open Sans', Arial, sans-serif;
	font-size: 2.2vh;
	font-weight: 600;
	cursor: pointer;
	display: block;
	box-shadow: 0 0.5vh 1vh rgba(0, 0, 0, 0.2);
	transition: box-shadow 0.1s ease-in-out;
}

button:hover {
	box-shadow: none;
}

button:active {
	box-shadow: 0 0 0 0.5vh white inset;
}

/* Pretty toggle styles */
.toggle-row {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 0.6rem;
	padding: 0.45rem 0.25rem;
	border-radius: 10px;
}
.toggle-title {
	font-size: 1.1rem;
	font-weight: 700;
	letter-spacing: 0.01em;
	color: #c9b3ff; /* soft purple */
	text-shadow: 0 0 8px rgba(140, 82, 255, 0.6);
}
.toggle-right {
	display: inline-flex;
	align-items: center;
	gap: 0.4rem;
}
.toggle-off, .toggle-on {
	font-size: 0.85rem;
	font-weight: 700;
	letter-spacing: 0.03em;
}
.toggle-off { color: #888; }
.toggle-on { color: #888; }
.toggle-row.is-on .toggle-on { color: #00c16e; }
.toggle-row:not(.is-on) .toggle-off { color: #ff3b3b; }

/* Switch */
.switch {
	position: relative;
	display: inline-block;
	width: 62px;
	height: 30px;
}
.switch input { display: none; }
.slider {
	position: absolute;
	cursor: pointer;
	top: 0; left: 0; right: 0; bottom: 0;
	background-color: #b31b1b; /* red when OFF */
	transition: 0.2s ease;
	border-radius: 30px;
	box-shadow: 0 0 10px rgba(140, 82, 255, 0.5); /* purple glow */
}
.slider:before {
	position: absolute;
	content: "";
	height: 24px;
	width: 24px;
	left: 3px;
	top: 3px;
	background-color: #fff;
	border-radius: 50%;
	transition: 0.2s ease;
}

.switch input:checked + .slider {
	background-color: #00c16e; /* green when ON */
	box-shadow: 0 0 14px rgba(140, 82, 255, 0.9); /* stronger glow */
}
.switch input:checked + .slider:before { transform: translateX(32px); }

#addon {
	/* Make the main container responsive and single-column */
	width: 100%;
	max-width: 720px;
	margin: auto;
}

.logo {
	height: 14vh;
	width: 14vh;
	margin: auto;
	margin-bottom: 3vh;
}

.logo img {
	width: 100%;
}

.name, .version {
	display: inline-block;
	vertical-align: top;
}

.name {
	line-height: 5vh;
	margin: 0;
}

.version {
	position: relative;
	line-height: 5vh;
	opacity: 0.8;
	margin-bottom: 2vh;
}

.contact {
	position: absolute;
	left: 0;
	bottom: 4vh;
	width: 100%;
	text-align: center;
}

.contact a {
	font-size: 1.4vh;
	font-style: italic;
}

.separator {
	margin-bottom: 4vh;
}

.form-element {
	margin-bottom: 2vh;
}

.label-to-top {
	margin-bottom: 2vh;
}

.label-to-right {
	margin-left: 1vh !important;
}

.full-width {
	width: 100%;
}

/* Actions row: install + copy side by side */
.actions-row {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: 1rem;
	flex-wrap: wrap;
}
.actions-row .install-link button,
.actions-row #copyManifestLink {
	margin: 0; /* override global button margin */
}

@keyframes pulse {
	0% { box-shadow: 0 0 0 0 rgba(140, 82, 255, 0.3); }
	70% { box-shadow: 0 0 0 16px rgba(140, 82, 255, 0); }
	100% { box-shadow: 0 0 0 0 rgba(140, 82, 255, 0); }
}

/* Stili per la griglia dei provider TV */
.tv-provider-grid {
	display: grid;
	grid-template-columns: repeat(2, 1fr);
	gap: 0.5rem;
	padding: 0.5rem;
	background: rgba(0,0,0,0.2);
	border-radius: 10px;
	margin-bottom: 2vh;
}
.tv-provider-item .toggle-row {
	padding: 0.2rem 0.1rem; /* Padding ridotto */
}
.tv-provider-item .toggle-title {
	font-size: 0.9rem; /* Font più piccolo */
}
.tv-provider-item .switch {
	transform: scale(0.85); /* Switch più piccolo */
}
.tv-provider-item .toggle-off, .tv-provider-item .toggle-on {
	display: none; /* Nasconde testo ON/OFF per compattezza */
}
`

function landingTemplate(manifest: any) {
	const background = manifest.background || 'https://dl.strem.io/addon-background.jpg'
	const logo = manifest.logo || 'https://dl.strem.io/addon-logo.png'
	const contactHTML = manifest.contactEmail ?
		`<div class="contact">
			<p>Contact ${manifest.name} creator:</p>
			<a href="mailto:${manifest.contactEmail}">${manifest.contactEmail}</a>
		</div>` : ''

	const stylizedTypes = manifest.types
		.map((t: string) => t[0].toUpperCase() + t.slice(1) + (t !== 'series' ? 's' : ''))

	let formHTML = ''
	let script = ''

	if ((manifest.config || []).length) {
		let options = ''
		const tvProviderKeys = new Set(['freeTvProvidersEnabled', 'mfpTvProvidersEnabled']);
		let inTvProviderGroup = false;


		manifest.config.forEach((elem: any) => {
			const key = elem.key
			if (["text", "number", "password"].includes(elem.type)) {
				const isRequired = elem.required ? ' required' : '';
				const defaultHTML = elem.default ? ` value="${elem.default}"` : ''
				const inputType = elem.type
				options += `
				<div class="form-element">
					<div class="label-to-top">${elem.title}</div>
					<input type="${inputType}" id="${key}" name="${key}" class="full-width"${defaultHTML}${isRequired}/>
				</div>
				`
				} else if (elem.type === 'checkbox') {
					const isTvProvider = tvProviderKeys.has(key);

					// Gestione del gruppo di provider TV
					if (isTvProvider && !inTvProviderGroup) {
						options += '<div class="tv-provider-grid">';
						inTvProviderGroup = true;
					}
					if (!isTvProvider && inTvProviderGroup) {
						options += '</div>';
						inTvProviderGroup = false;
					}
					// Custom pretty toggle for known keys
					const toggleMap: any = {
						'disableVixsrc': { title: 'VixSrc 🍿 - 🔒', invert: true, requiresMfp: true }, // Mantenuto per coerenza
						'disableLiveTv': { title: 'LiveTV 📺', invert: true },
						'freeTvProvidersEnabled': { title: '📺 Provider senza MFP 🔓', invert: false },
						'mfpTvProvidersEnabled': { title: '📺 Provider con MFP 🔒', invert: false, requiresMfp: true },
						'animeunityEnabled': { title: 'Anime Unity ⛩️ - 🔒', invert: false, requiresMfp: true },
						'animesaturnEnabled': { title: 'Anime Saturn 🪐 - 🔒', invert: false, requiresMfp: true }, // Mantenuto
						'animeworldEnabled': { title: 'Anime World 🌍 - 🔓', invert: false },
						'guardaserieEnabled': { title: 'GuardaSerie 🎥 - 🔓', invert: false },
						'guardahdEnabled': { title: 'GuardaHD 🎬 - 🔓', invert: false },
						'eurostreamingEnabled': { title: 'Eurostreaming ▶️ - 🔓', invert: false },
					}
					if (toggleMap[key]) {
						const t = toggleMap[key];
						// Determine checked from elem.default boolean if provided; default visually ON
						const hasDefault = (typeof (elem as any).default === 'boolean');
						// For inverted toggles (disable*), show ON when default=false (i.e., feature enabled)
						const isChecked = hasDefault ? (t.invert ? !((elem as any).default as boolean) : !!(elem as any).default) : true;
						const checkedAttr = isChecked ? ' checked' : '';
						const itemClass = isTvProvider ? 'tv-provider-item' : 'form-element';
						options += `
						<div class="${itemClass}">
							<div class="toggle-row" data-toggle-row="${key}">
								<span class="toggle-title">${t.title}</span>
								<div class="toggle-right">
									<span class="toggle-off">OFF</span>
									<label class="switch">
										<input type="checkbox" id="${key}" name="${key}" data-config-key="${key}" data-invert="${t.invert ? 'true' : 'false'}"${checkedAttr} />
										<span class="slider"></span>
									</label>
									<span class="toggle-on">ON</span>
								</div>
							</div>
						</div>
						`
					} else {
						// Support boolean default as well as legacy 'checked'
						const isChecked = (typeof (elem as any).default === 'boolean')
							? (((elem as any).default as boolean) ? ' checked' : '')
							: (elem.default === 'checked' ? ' checked' : '')
						options += `
						<div class="form-element">
							<label for="${key}">
								<input type="checkbox" id="${key}" name="${key}"${isChecked}> <span class="label-to-right">${elem.title}</span>
							</label>
						</div>
						`
					}
			} else if (elem.type === 'select') {
				const defaultValue = elem.default || (elem.options || [])[0]
				options += `<div class="form-element">
				<div class="label-to-top">${elem.title}</div>
				<select id="${key}" name="${key}" class="full-width">
				`
				const selections = elem.options || []
				selections.forEach((el: string) => {
					const isSelected = el === defaultValue ? ' selected' : ''
					options += `<option value="${el}"${isSelected}>${el}</option>`
				})
				options += `</select>
               </div>
               `
			}
		})

		// Chiudi il gruppo dei provider TV se era l'ultimo elemento
		if (inTvProviderGroup) {
			options += '</div>';
		}

		if (options.length) {
			formHTML = `
			<form class="pure-form" id="mainForm">
				${options}
			</form>

			<div class="separator"></div>
			`
			script += `
			var installLink = document.getElementById('installLink');
			var mainForm = document.getElementById('mainForm');
			if (installLink && mainForm) {
				installLink.onclick = function () { return (mainForm && typeof mainForm.reportValidity === 'function') ? mainForm.reportValidity() : true; };
				var buildConfigFromForm = function() {
					var config = {}; // Inizializza un oggetto di configurazione vuoto

					// Gestione dei provider TV raggruppati
					var freeTvEnabled = !!document.getElementById('freeTvProvidersEnabled')?.checked;
					var mfpTvEnabled = !!document.getElementById('mfpTvProvidersEnabled')?.checked;

					// Abilita dTV se uno dei due gruppi è attivo
					config.dtvEnabled = freeTvEnabled || mfpTvEnabled; 

					// Provider gratuiti (escluso dTV già gestito)
					config.plutoEnabled = freeTvEnabled;
					config.tvtapProxyEnabled = freeTvEnabled;
					config.vavooNoProxyEnabled = freeTvEnabled;

					// Provider con MFP
					config.plutoMfpEnabled = mfpTvEnabled;
					config.tvtapMfpEnabled = mfpTvEnabled;
					config.daddyEnabled = mfpTvEnabled;
					config.vavooMfpEnabled = mfpTvEnabled;

					var elements = (mainForm).querySelectorAll('input, select, textarea');
					elements.forEach(function(el) {
						var key = el.id || el.getAttribute('name') || '';
						if (!key) return;

						// Salta gli input disabilitati, specialmente quelli dei provider TV nascosti.
						if (el.disabled) {
							// Per i checkbox, assicurati che il valore sia false se disabilitato
							if (el.type === 'checkbox') config[key] = false;
							return;
						}

						if (el.type === 'checkbox') {
							var cfgKey = el.getAttribute('data-config-key') || key;
							var invert = el.getAttribute('data-invert') === 'true';
							var val = !!el.checked;
							config[cfgKey] = invert ? !val : val;
						} else {
							config[key] = el.value; // Gestisce text, select, etc.
						}
					});
					return config;
				};
				var updateLink = function() {
					var config = buildConfigFromForm();
					installLink.setAttribute('href', 'stremio://' + window.location.host + '/' + encodeURIComponent(JSON.stringify(config)) + '/manifest.json');
				};
					(mainForm).onchange = updateLink;
					// initialize toggle visual ON/OFF state classes
					var toggleRows = (mainForm).querySelectorAll('[data-toggle-row]');
					var setRowState = function(row){
						if (!row) return;
						var input = row.querySelector('input[type="checkbox"]');
						if (!input) return;
						if (input.checked) { row.classList.add('is-on'); } else { row.classList.remove('is-on'); }
					};
					toggleRows.forEach(function(row){
						setRowState(row);
						var input = row.querySelector('input[type="checkbox"]');
						if (input) input.addEventListener('change', function(){ setRowState(row); });
					});

					// Live TV dependency logic
					var checkLiveTvDependencies = function() {
						var liveTvToggle = document.getElementById('disableLiveTv');
						var isLiveTvDisabled = liveTvToggle ? liveTvToggle.checked : false; // direct logic
						var tvGrid = document.querySelector('.tv-provider-grid');
						
						var liveTvDependentKeys = ['freeTvProvidersEnabled', 'mfpTvProvidersEnabled'];

						if (tvGrid) {
							if (!isLiveTvDisabled) {
								liveTvDependentKeys.forEach(function(key) {
									var input = document.getElementById(key);
									if (input) input.disabled = true;
								});
								tvGrid.style.display = 'none';
							} else {
								tvGrid.style.display = 'grid';
								liveTvDependentKeys.forEach(function(key) {
									var input = document.getElementById(key);
									if (input) input.disabled = false;
								});
							}
						}
						
						// After showing/hiding Live TV options, check MFP dependencies
						checkMfpDependencies();
						
						// Update the link after changing Live TV dependencies
						updateLink();
					};

					// MFP dependency logic
					var checkMfpDependencies = function() {
						var mfpUrlInput = document.getElementById('mediaFlowProxyUrl');
						var mfpPasswordInput = document.getElementById('mediaFlowProxyPassword');						
						var hasMfpConfig = mfpUrlInput && mfpPasswordInput && mfpUrlInput.value.trim() && mfpPasswordInput.value.trim();						
						
						// Definisci i gruppi di provider
						var mfpDependentKeys = ['disableVixsrc', 'mfpTvProvidersEnabled', 'animeunityEnabled', 'animesaturnEnabled'];

						mfpDependentKeys.forEach(function(key) {
							var input = document.getElementById(key);
							var row = document.querySelector('[data-toggle-row="' + key + '"]');
							if (input && row && row.style.display !== 'none') { // Only process visible rows
								if (!hasMfpConfig) {
									// Se MFP non è configurato, disabilita e deseleziona le opzioni dipendenti.
									input.checked = false;
									input.disabled = true;
									row.style.opacity = '0.5';
									row.style.pointerEvents = 'none';
								} else {
									// Se MFP è configurato, abilita E SELEZIONA le opzioni dipendenti.
									if (input.disabled) { // Applica solo la prima volta che vengono abilitati
										input.checked = true;
									}
									input.disabled = false;
									row.style.opacity = '1';
									row.style.pointerEvents = 'auto';
								}
								setRowState(row);
							}
						});
						updateLink(); // Aggiorna il link di installazione dopo aver modificato i toggle
					};
					
					// Check Live TV dependencies on page load
					checkLiveTvDependencies();
					
					// Monitor Live TV toggle for changes
					var liveTvToggle = document.getElementById('disableLiveTv');
					if (liveTvToggle) liveTvToggle.addEventListener('change', checkLiveTvDependencies);

					// Monitor MFP fields for changes
					var mfpUrl = document.getElementById('mediaFlowProxyUrl');
					var mfpPassword = document.getElementById('mediaFlowProxyPassword');
					if (mfpUrl) mfpUrl.addEventListener('input', checkMfpDependencies);
					if (mfpPassword) mfpPassword.addEventListener('input', checkMfpDependencies);

					// Update link immediately after initialization
					updateLink();

				// expose globally for bottom script
					window.updateLink = updateLink;
			}
			`
		}
	}

	// Aggiunge la logica per il pulsante "Copia Manifest" allo script
	// Questa logica viene aggiunta indipendentemente dalla presenza di un form di configurazione
	script += `
		var copyManifestLink = document.getElementById('copyManifestLink');
		if (copyManifestLink) {
			copyManifestLink.onclick = function () {
				var manifestUrl;
				var mainForm = document.getElementById('mainForm');
				if (mainForm) {
					var config = buildConfigFromForm(); // Use the same function with Live TV logic
					manifestUrl = window.location.protocol + '//' + window.location.host + '/' + encodeURIComponent(JSON.stringify(config)) + '/manifest.json';
				} else {
					manifestUrl = window.location.protocol + '//' + window.location.host + '/manifest.json';
				}
				try {
					if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
						navigator.clipboard.writeText(manifestUrl).then(function(){
							copyManifestLink.textContent = 'COPIATO!';
							copyManifestLink.style.background = '#1f8b4c';
							copyManifestLink.style.boxShadow = '0 0 12px rgba(31, 139, 76, 0.8)';
							setTimeout(function(){
								copyManifestLink.textContent = 'COPIA MANIFEST URL';
								copyManifestLink.style.background = '#8A5AAB';
								copyManifestLink.style.boxShadow = '0 0.5vh 1vh rgba(0, 0, 0, 0.2)';
							}, 1600);
						});
					} else {
						throw new Error('Clipboard API non disponibile');
					}
				} catch (err) {
					console.error('Errore durante la copia: ', err);
					alert("Impossibile copiare l'URL. Copialo manualmente: " + manifestUrl);
				}
				return false;
			};
		}
		// Toggle sezione ElfHosted
		try {
			var features = document.getElementById('privateInstanceFeatures');
			var toggleBtn = document.getElementById('togglePrivateFeatures');
			var icon = toggleBtn ? toggleBtn.querySelector('.toggle-icon') : null;
			if (features && toggleBtn) {
				features.style.display = 'none';
				toggleBtn.addEventListener('click', function(e) {
					if (e && typeof e.preventDefault === 'function') e.preventDefault();
					var isHidden = features.style.display === 'none';
					features.style.display = isHidden ? 'block' : 'none';
					if (icon) { icon.style.transform = isHidden ? 'rotate(180deg)' : 'rotate(0deg)'; }
				});
			}
		} catch (e) { console.warn(e); }
	`;

	return `
	<!DOCTYPE html>
	<html style="background-image: url(${background});">

	<head>
		<meta charset="utf-8">
		<title>${manifest.name} - Stremio Addon</title>
		<style>${STYLESHEET}</style>
		<link rel="shortcut icon" href="${logo}" type="image/x-icon">
		<link href="https://fonts.googleapis.com/css?family=Open+Sans:400,600,700&display=swap" rel="stylesheet">
		<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/purecss@2.1.0/build/pure-min.css" integrity="sha384-yHIFVG6ClnONEA5yB5DJXfW2/KC173DIQrYoZMEtBvGzmf0PKiGyNEqe9N6BNDBH" crossorigin="anonymous">
	</head>

	<body>
		<div id="addon">
			<div class="logo">
			<img src="${logo}">
			</div>
			<h1 class="name">${manifest.name}</h1>
			<h2 class="version">v${manifest.version || '0.0.0'}</h2>
			<h2 class="description">StreamViX addon con Vixsrc, Guardaserie, Altadefinizione, AnimeUnity, AnimeSaturn, AnimeWorld, TV ed Eventi Live</h2>

			<!-- Sezione informativa ElfHosted (sotto la descrizione) -->
			<div id="elfhostedInfoSection" class="full-width" style="background: linear-gradient(135deg, rgba(40, 20, 80, 0.95), rgba(10, 30, 60, 0.95)); border-radius: 0.6rem; padding: 1rem; margin: 1rem 0px; border: 1px solid rgba(140, 82, 255, 0.95); animation: 2s ease 0s infinite normal none running pulse; display: block;">
				<p style="font-size: 1rem; text-align: center; margin-bottom: 0.5rem; color: #fff;">
					<span style="font-weight: 600; color: #8c52ff;"> NUOVO PARTNER DI HOSTING </span>
				</p>
				<p style="text-align: center; margin-bottom: 0.75rem;">
					Infrastruttura di hosting donata da <a href="https://elfhosted.com/" target="_blank" style="color: #00c16e; font-weight: 600; text-decoration: none;">ElfHosted</a> ❤️ e
					mantenuta in modo indipendente da <a href="https://hayd.uk" target="_blank" style="color: #00a3ff; font-weight: 600; text-decoration: none;">Hayduk</a>. Consulta la <a href="https://stremio-addons-guide.elfhosted.com/" target="_blank" style="color: #00a3ff; font-weight: 600; text-decoration: none;">Guida agli addon Stremio di ElfHosted</a>
					per altri addon, oppure ottieni <a href="https://store.elfhosted.com/product/streamvix/" target="_blank" style="color: #00c16e; font-weight: 600; text-decoration: none;">la tua istanza privata e isolata (con MediaflowProxy 4K)</a> (<i>sostieni direttamente il tuo sviluppatore!</i>)
				</p>

				<!-- Pulsante di toggle per le funzionalità dell'istanza privata -->
				<div style="text-align: center; margin-bottom: 0.5rem;">
					<button id="togglePrivateFeatures" type="button" class="toggle-btn" style="display: inline-flex; align-items: center; background-color: rgba(80, 40, 140, 0.95); border-radius: 0.4rem; padding: 0.4rem 0.8rem; border: 1px solid rgba(140, 82, 255, 0.95); cursor: pointer;">
						<span class="toggle-icon" style="margin-right: 0.5rem; transition: transform 0.3s ease;">▼</span>
						<span style="font-weight: 500; color: #8c52ff;">Mostra le funzionalità dell'istanza privata</span>
					</button>
				</div>

				<!-- Sezione a scomparsa con le funzionalità -->
				<div id="privateInstanceFeatures" class="cookie-config collapsed" style="background: rgba(10, 10, 12, 0.96); margin-top: 0.5rem; display: none;">
					<div style="padding: 0.75rem;">
						<h3 style="font-size: 0.95rem; margin-bottom: 0.75rem; color: #fff; text-align: center;">Informazioni sull'istanza privata ElfHosted</h3>

						<ul style="list-style-type: none; padding: 0; margin: 0;">
							<li style="display: flex; align-items: flex-start; margin-bottom: 0.6rem;">
								<span style="color: #00c16e; margin-right: 0.5rem;">•</span>
								<span style="font-size: 0.85rem; color: #fff;">Istanze private con rate‑limit separati fino a 4K</span>
							</li>
							<li style="display: flex; align-items: flex-start; margin-bottom: 0.6rem;">
								<span style="color: #00c16e; margin-right: 0.5rem;">•</span>
								<span style="font-size: 0.85rem; color: #fff;">Recupero link più veloce</span>
							</li>
							<li style="display: flex; align-items: flex-start; margin-bottom: 0.6rem;">
								<span style="color: #00c16e; margin-right: 0.5rem;">•</span>
								<span style="font-size: 0.85rem; color: #fff;">Tutti i link sono raggiungibili a differenza di Render e Huggingface (Mediaflow)</span>
							</li>
							<li style="display: flex; align-items: flex-start; margin-bottom: 0;">
								<span style="color: #00c16e; margin-right: 0.5rem;">•</span>
								<span style="font-size: 0.85rem; color: #fff;">Il 33% dei costi di hosting va allo sviluppo dell'addon</span>
							</li>
						</ul>

					<div style="margin-top: 1rem; background: rgba(5, 5, 8, 0.96); border-radius: 0.5rem; padding: 0.75rem; border: 1px dashed rgba(140, 82, 255, 0.85);">
						<p style="font-size: 0.85rem; color: #fff; margin: 0; text-align: center;">
							Ospitato da ElfHosted con prova gratuita disponibile
						</p>
					</div>

					<div style="text-align: center; margin-top: 1rem;">
						<a href="https://store.elfhosted.com/product/streamvix/" target="_blank" style="display: inline-block; padding: 0.5rem 1rem; background: rgba(140, 82, 255, 0.85); color: #fff; font-weight: 600; font-size: 0.9rem; border-radius: 0.5rem; text-decoration: none; border: 1px solid rgba(140, 82, 255, 0.9);">Vedi su ElfHosted</a>
					</div>
				</div>
			</div>

			<div class="separator"></div>

			<!-- INFO Icone -->
			<div style="text-align: center; margin-bottom: 2vh; padding: 0.5rem; background: rgba(0,0,0,0.3); border-radius: 8px;">
				<p style="font-size: 1rem; margin: 0.2rem 0;">INFO: </p>
				<p style="font-size: 0.9rem; margin: 0.2rem 0;">🔓 = Utilizzabile senza MediaFlow Proxy (MFP)</p>
				<p style="font-size: 0.9rem; margin: 0.2rem 0;">🔒 = Richiede MediaFlow Proxy (MFP)</p>
			</div>

			<h3 class="gives">In Questo Addon puoi trovare :</h3>
			<ul>
			${stylizedTypes.map((t: string) => `<li>${t}</li>`).join('')}
			</ul>

			<div class="separator"></div>

			${formHTML}

			<div class="actions-row">
				<a id="installLink" class="install-link" href="#">
					<button name="Install">INSTALLA SU STREMIO</button>
				</a>
				<button id="copyManifestLink">COPIA MANIFEST URL</button>
			</div>
			${contactHTML}
		</div>
		<script>
			${script}
			try {
				if (typeof window.updateLink === 'function') {
					window.updateLink();
				} else {
					var installLink = document.getElementById('installLink');
					if (installLink) installLink.setAttribute('href', 'stremio://' + window.location.host + '/manifest.json');
				}
			} catch (e) { /* no-op */ }
		</script>
	</body>

	</html>`
}

export { landingTemplate };
