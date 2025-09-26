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
	/* Responsive base font size: never smaller than 15px, scales with viewport height */
	font-size: clamp(15px, 2.2vh, 22px);
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
	font-size: clamp(28px, 5vh, 54px);
	font-weight: 700;
}

h2 {
	font-size: clamp(17px, 2.6vh, 30px);
	font-weight: normal;
	font-style: italic;
	opacity: 0.8;
}

h3 {
	font-size: clamp(17px, 2.6vh, 30px);
}

h1,
h2,
h3,
p {
	margin: 0;
	text-shadow: 0 0 1vh rgba(0, 0, 0, 0.15);
}

p {
	font-size: clamp(14px, 2vh, 22px);
}

ul {
	font-size: clamp(14px, 2vh, 22px);
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
	font-size: clamp(16px, 2.4vh, 26px);
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
.toggle-row.dimmed {
	/* Non oscura più l'intera riga, ma solo il selettore a destra */
}
.toggle-row.dimmed .toggle-right {
	filter: grayscale(100%);
	opacity: 0.55;
	transition: opacity 0.2s ease, filter 0.2s ease;
}
/* Forza il colore rosso quando il toggle è spento e oscurato */
.toggle-row.dimmed .switch input:not(:checked) + .slider {
	background-color: #b31b1b !important;
}
.toggle-title {
	font-size: clamp(0.95rem, 2.1vh, 1.35rem);
	font-weight: 700;
	letter-spacing: 0.01em;
	color: #c9b3ff; /* soft purple */
	text-shadow: 0 0 8px rgba(140, 82, 255, 0.6);
}
.toggle-row.dimmed .toggle-title { color:#555 !important; text-shadow:none; }
.toggle-right {
	display: inline-flex;
	align-items: center;
	gap: 0.4rem;
}
.toggle-off, .toggle-on {
	font-size: clamp(0.75rem, 1.8vh, 1rem);
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
/* Preset buttons */
.preset-btn { background:#4d2d66; border:1px solid #8c52ff; color:#fff; font-weight:600; padding:0.45rem 0.6rem; border-radius:8px; cursor:pointer; box-shadow:0 0 8px rgba(140,82,255,0.4); transition:background .2s, transform .15s; }
.preset-btn:hover { background:#5c3780; }
.preset-btn:active { transform:scale(.95); }
.preset-btn.active { background:#00c16e; border-color:#00c16e; box-shadow:0 0 10px rgba(0,193,110,0.7); }
/* VixSrc Local/Dual pill styles (restored) */
.vix-pill { display:inline-block; padding:2px 8px; margin-left:6px; font-size:0.6rem; font-weight:700; border:1px solid #8c52ff; border-radius:14px; background:#4d2d66; letter-spacing:0.05em; opacity:0.85; transition:background .2s, color .2s, opacity .2s; user-select:none; cursor:pointer; }
.vix-pill.on { background:#00c16e; border-color:#00c16e; color:#fff; opacity:1; box-shadow:0 0 8px rgba(0,193,110,0.6); }
.vix-pill.off { background:#333; color:#bbb; }
.vix-pill.disabled { filter:grayscale(100%); opacity:.35; cursor:not-allowed; }
.vix-pill input { display:none; }
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
		// We'll collect auto-generated options, but skip tmdbApiKey & personalTmdbKey here to custom place them at top later
		manifest.config.forEach((elem: any) => {
			const key = elem.key
				if (["text", "number", "password"].includes(elem.type)) {
					if (key === 'tmdbApiKey') {
						// Remove custom TMDB key field from UI entirely (use default only)
						return;
					}
					const isRequired = elem.required ? ' required' : ''
					const defaultHTML = elem.default ? ` value="${elem.default}"` : ''
					const inputType = elem.type
					options += `
					<div class="form-element">
						<div class="label-to-top">${elem.title}</div>
						<input type="${inputType}" id="${key}" name="${key}" class="full-width"${defaultHTML}${isRequired}/>
					</div>
					`
				} else if (elem.type === 'checkbox') {
					// Skip only personalTmdbKey (custom placement); mediaflowMaster & localMode will be moved later
					if (key === 'personalTmdbKey') return; // removed from UI
					// Custom pretty toggle for known keys
						const toggleMap: any = {
						'disableVixsrc': { title: 'VixSrc 🍿 - 🔒 <span style="font-size:0.65rem; opacity:0.75; font-weight:600;">(Inserisci MFP per abilitare)</span>', invert: true },
						'disableLiveTv': { title: 'Live TV 📺 <span style="font-size:0.65rem; opacity:0.75; font-weight:600;">(Molti canali hanno bisogno di MFP)</span>', invert: true },
						'animeunityEnabled': { title: 'Anime Unity ⛩️ - 🔒 <span style="font-size:0.65rem; opacity:0.75; font-weight:600;">(Inserisci MFP per abilitare)</span>', invert: false },
						'animesaturnEnabled': { title: 'Anime Saturn 🪐 - 🔓 🔒 <span style="font-size:0.65rem; opacity:0.75; font-weight:600;">(Alcuni flussi hanno bisogno di MFP)</span>', invert: false },
						'animeworldEnabled': { title: 'Anime World 🌍 - 🔓', invert: false },
						'guardaserieEnabled': { title: 'GuardaSerie 🎥 - 🔓', invert: false },
						'guardahdEnabled': { title: 'GuardaHD 🎬 - 🔓', invert: false },
						'eurostreamingEnabled': { title: 'Eurostreaming ▶️ - 🔓 <span style="font-size:0.65rem; opacity:0.75; font-weight:600;">(funziona in locale)</span>', invert: false },
						'cb01Enabled': { title: 'CB01 🎞️ - 🔒 <span style="font-size:0.65rem; opacity:0.75; font-weight:600;">(Inserisci MFP per abilitare)</span>', invert: false },
						'streamingwatchEnabled': { title: 'StreamingWatch 📼 - 🔓', invert: false },
							'tvtapProxyEnabled': { title: 'TvTap NO MFP 🔓', invert: false },
							'vavooNoMfpEnabled': { title: 'Vavoo NO MFP 🔓', invert: false },
							'mediaflowMaster': { title: 'MediaflowProxy 🔄', invert: false },
					}
						if (toggleMap[key]) {
						const t = toggleMap[key];
						// Determine checked from elem.default boolean if provided; default visually ON
						const hasDefault = (typeof (elem as any).default === 'boolean');
						// For inverted toggles (disable*), show ON when default=false (i.e., feature enabled)
						let isChecked = hasDefault ? (t.invert ? !((elem as any).default as boolean) : !!(elem as any).default) : true;
						// Force Eurostreaming OFF by default (unless explicit default true)
							if (key === 'eurostreamingEnabled' && !hasDefault) isChecked = false;
						const checkedAttr = isChecked ? ' checked' : '';
						const extraAttr = key==='mediaflowMaster' ? ' data-master-mfp="1"' : '';
						const extraAttrTmdb = key==='personalTmdbKey' ? ' data-personal-tmdb="1"' : '';
							// Inject Local checkbox ONLY for VixSrc row (between title and main toggle)
							let extraLocal = '';
							if (key === 'disableVixsrc') {
								// Restore Local & Dual pills (no addonBase field)
								extraLocal = `
								<span id="localPill" class="vix-pill off" title="Flusso diretto (senza MediaflowProxy)">
									<label style="cursor:pointer;">
										<input type="checkbox" id="vixLocal" name="vixLocal" data-config-key="vixLocal" />LOCAL
									</label>
								</span>
								<span id="dualPill" class="vix-pill off" title="Mostra anche la variante 1080p forzata (FHD)">
									<label style="cursor:pointer;">
										<input type="checkbox" id="vixDual" name="vixDual" data-config-key="vixDual" />FHD
									</label>
								</span>`;
							}
							options += `
							<div class="form-element"${extraAttr}${extraAttrTmdb}>
								<div class="toggle-row" data-toggle-row="${key}">
									<span class="toggle-title">${t.title}${extraLocal}</span>
									<div class="toggle-right">
										<span class="toggle-off">OFF</span>
										<label class="switch">
											<input type="checkbox" id="${key}" name="${key}" data-config-key="${key}" data-main-toggle="1" data-invert="${t.invert ? 'true' : 'false'}"${checkedAttr} />
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
		if (options.length) {
			formHTML = `
			<form class="pure-form" id="mainForm">
				<!-- Preset Installazioni consigliate -->
				<div style="margin:0 0 1rem 0; padding:0.75rem; border:1px solid rgba(140,82,255,0.55); border-radius:10px; background:rgba(20,15,35,0.55);">
					<div style="font-weight:700; margin-bottom:0.5rem; text-align:center; color:#c9b3ff;">Installazioni consigliate</div>
					<div id="presetInstallations" style="display:grid; grid-template-columns:repeat(2, minmax(120px,1fr)); gap:0.5rem; justify-items:stretch; align-items:stretch;">
						<!-- Colonna sinistra -->
						<button type="button" data-preset="pubblicamfp" class="preset-btn" style="min-width:120px;">Pubblica (MFP)</button>
						<button type="button" data-preset="locale" class="preset-btn" style="min-width:120px;">Locale</button>
						<!-- Colonna sinistra seconda riga (NO MFP) e destra seconda riga (OCI) -->
						<button type="button" data-preset="pubblicanomfp" class="preset-btn" style="min-width:140px;">Pubblica (NO MFP)</button>
						<button type="button" data-preset="oci" class="preset-btn" style="min-width:140px;">OCI/Render</button>
					</div>
					<p style="margin:0.6rem 0 0 0; font-size:0.7rem; opacity:0.75; text-align:center;">I preset impostano automaticamente i provider consigliati.</p>
				</div>
				<!-- Manual placement containers for MediaflowProxy and Local (Eurostreaming) -->
				<div id="mediaflowManualSlot"></div>

				<!-- Centered MediaflowProxy toggle (custom) will be auto-generated below; we move its element after generation via script if needed -->
				${options}
				<div id="liveTvSubToggles" style="display:none; margin:0.5rem 0 1rem 0; padding:0.6rem 0.8rem; border:1px dashed rgba(140,82,255,0.6); border-radius:8px;">
					<p style="margin:0 0 0.5rem 0; font-size:0.95rem; color:#c9b3ff; font-weight:600; text-align:center;">Opzioni Live TV</p>
					<!-- TvTap & Vavoo toggles will already be present in form; this container just groups them visually -->
				</div>
				${manifest.__resolvedAddonBase ? (() => { const _raw = manifest.__resolvedAddonBase; const _host = _raw.replace(/^https?:\/\//,''); const _isFallback = /streamvix\.hayd\.uk/.test(_raw); return `<div id="svxAddonBaseBadge" style="text-align:center; margin:-0.25rem 0 1.1rem 0;">
					<span style=\"display:inline-block; padding:0.35rem 0.75rem; background:rgba(0,0,0,0.45); border:1px solid rgba(140,82,255,0.65); border-radius:14px; font-size:0.70rem; letter-spacing:0.05em; font-weight:600; color:#c9b3ff;\" title=\"Addon Base URL risolta all'avvio\">Addon Base URL per Vix FHD: <span style='color:#00c16e;'>${_host}</span><a href=\"https://github.com/qwertyuiop8899/StreamViX/blob/main/README.md\" target=\"_blank\" style=\"text-decoration:none; margin-left:6px; color:#8c52ff;\">📖 README</a></span>
				</div>` })() : ''}
			</form>

			<div class="separator"></div>
			`
			script += `
			console.log('[SVX] Main form logic init');
			var installLink = document.getElementById('installLink');
			var mainForm = document.getElementById('mainForm');
			if (installLink && mainForm) {
					// Basic runtime guard & error surface
					try { window.__SVX_OK = true; } catch(e) {}
				installLink.onclick = function () { return (mainForm && typeof mainForm.reportValidity === 'function') ? mainForm.reportValidity() : true; };
				var buildConfigFromForm = function() {
					var config = {};
					var elements = (mainForm).querySelectorAll('input, select, textarea');
					elements.forEach(function(el) {
						var key = el.id || el.getAttribute('name') || '';
						if (!key) return;
						if (['personalTmdbKey'].includes(key)) return; // exclude only personal key; include mediaflowMaster in config
						if (el.type === 'checkbox') {
							var cfgKey = el.getAttribute('data-config-key') || key;
							var invert = el.getAttribute('data-invert') === 'true';
							var val = !!el.checked;
							config[cfgKey] = invert ? !val : val;
						} else {
							config[key] = el.value;
						}
					});
					// (Reverted) no addonBase injection in legacy version
					// tmdbApiKey always kept (UI hidden)
					return config;
				};
				// expose builder early (plain JS, no TS casts)
				// NOTE: avoid TS only syntax inside runtime JS string
				// Expose globally (plain JS)
					try { window.buildConfigFromForm = buildConfigFromForm; } catch(e){}
				var updateLink = function() {
					var config = buildConfigFromForm();
					installLink.setAttribute('href', 'stremio://' + window.location.host + '/' + encodeURIComponent(JSON.stringify(config)) + '/manifest.json');
				};
					(mainForm).onchange = updateLink;
					// initialize toggle visual ON/OFF state classes
					var toggleRows = (mainForm).querySelectorAll('[data-toggle-row]');
					var setRowState = function(row){
						if (!row) return;
						// Use only the main toggle inside the right-hand switch area
						var input = row.querySelector('input[type="checkbox"][data-main-toggle="1"]');
						if (!input) return;
						if (input.checked) { row.classList.add('is-on'); } else { row.classList.remove('is-on'); }
					};
					toggleRows.forEach(function(row){
						setRowState(row);
						var input = row.querySelector('input[type="checkbox"][data-main-toggle="1"]');
						if (input) input.addEventListener('change', function(){ setRowState(row); });
					});

				// --- Custom dynamic visibility logic ---
				// Removed personal TMDB key UI

				// Reposition MediaflowProxy & Local toggles into manual slots
				var mediaflowWrapper = document.getElementById('mediaflowMaster') ? document.getElementById('mediaflowMaster').closest('.form-element'): null;
				var mediaSlot = document.getElementById('mediaflowManualSlot');
				if (mediaflowWrapper && mediaSlot){ mediaSlot.appendChild(mediaflowWrapper); }
				if (mediaflowWrapper){ mediaflowWrapper.style.maxWidth='480px'; mediaflowWrapper.style.margin='0 auto 0.5rem auto'; mediaflowWrapper.style.textAlign='center'; }

				// Mediaflow master toggle hides/shows URL + Password fields & disables Anime Unity + VixSrc (Saturn only note)
				var mfpMaster = document.querySelector('[data-master-mfp] input[type="checkbox"]') || document.getElementById('mediaflowMaster');
				var mfpUrlInput = document.getElementById('mediaFlowProxyUrl');
				var mfpPwdInput = document.getElementById('mediaFlowProxyPassword');
					var mfpUrlEl = mfpUrlInput ? mfpUrlInput.closest('.form-element') : null;
					var mfpPwdEl = mfpPwdInput ? mfpPwdInput.closest('.form-element') : null;
				var animeUnityEl = document.getElementById('animeunityEnabled');
				var animeSaturnEl = document.getElementById('animesaturnEnabled');
				var animeSaturnRow = animeSaturnEl ? animeSaturnEl.closest('[data-toggle-row]') : null;
				var animeSaturnTitleSpan = animeSaturnRow ? animeSaturnRow.querySelector('.toggle-title') : null;
				var originalSaturnTitle = animeSaturnTitleSpan ? animeSaturnTitleSpan.innerHTML : '';
				var vixsrcCb = document.getElementById('disableVixsrc');
				var vixsrcRow = vixsrcCb ? vixsrcCb.closest('[data-toggle-row]') : null;
				var animeUnityRow = animeUnityEl ? animeUnityEl.closest('[data-toggle-row]') : null;
				var cb01El = document.getElementById('cb01Enabled');
				var cb01Row = cb01El ? cb01El.closest('[data-toggle-row]') : null;
				var storedVixsrcState = null; // remember previous user choice
				var storedCb01State = null; // remember previous cb01 state
				function syncMfp(){
					var on = mfpMaster ? mfpMaster.checked : false; // default OFF
					var inputsFilled = mfpUrlInput && mfpPwdInput && mfpUrlInput.value.trim() !== '' && mfpPwdInput.value.trim() !== '';
					var canEnableChildren = on && inputsFilled;
					var currentPreset = (window.__SVX_PRESET || '');
					var noPreset = !currentPreset; // nessun preset selezionato

					if (mfpUrlEl) mfpUrlEl.style.display = on ? 'block':'none';
					if (mfpPwdEl) mfpPwdEl.style.display = on ? 'block':'none';
					if (animeUnityEl){
						// Regole aggiornate:
						// Allowed presets (può essere attivato se MFP + credenziali): locale, pubblicamfp, oci, nessun preset
						// Forbidden: pubblicanomfp (sempre OFF e dimmed)
						var isForbiddenPreset = currentPreset === 'pubblicanomfp';
						var isAllowedPreset = (!currentPreset) || currentPreset === 'locale' || currentPreset === 'pubblicamfp' || currentPreset === 'oci';
						if (isForbiddenPreset) {
							// Forzato OFF e dimmed
							animeUnityEl.checked = false;
							animeUnityEl.disabled = true;
							if (animeUnityRow) animeUnityRow.classList.add('dimmed');
						} else if (isAllowedPreset) {
							// Gestione gating MFP
							if (!on) {
								animeUnityEl.checked = false;
								animeUnityEl.disabled = true;
								if (animeUnityRow) animeUnityRow.classList.add('dimmed');
							} else {
								// MFP ON
								if (animeUnityRow) animeUnityRow.classList.remove('dimmed');
								// Abilitabile solo se credenziali complete
								animeUnityEl.disabled = !canEnableChildren;
								// Autocheck solo per locale o nessun preset; pubblicamfp e oci restano OFF di default
								if (canEnableChildren) {
									if ((currentPreset === 'locale' || noPreset) && !animeUnityEl.checked) {
										animeUnityEl.checked = true;
									} else if ((currentPreset === 'pubblicamfp' || currentPreset === 'oci') && animeUnityEl.checked && !animeUnityEl.wasUserClicked) {
										// Se per qualche motivo era rimasto checked da preset diverso, spegni (solo la prima volta)
										animeUnityEl.checked = false;
									}
								} else {
									animeUnityEl.checked = false;
								}
							}
						} else {
							// Qualsiasi altro preset non previsto: fallback a OFF dimmed
							animeUnityEl.checked = false;
							animeUnityEl.disabled = true;
							if (animeUnityRow) animeUnityRow.classList.add('dimmed');
						}
						if (animeUnityRow) setRowState(animeUnityRow);
					}
					if (animeSaturnEl){
						// Keep usable but add note when off
						if (animeSaturnTitleSpan){
							animeSaturnTitleSpan.innerHTML = originalSaturnTitle; // Reset
						}
					}
					if (vixsrcCb){
						if (!on) { // Master OFF
							if (storedVixsrcState === null) storedVixsrcState = vixsrcCb.checked;
							vixsrcCb.checked = false;
							vixsrcCb.disabled = true;
							if (vixsrcRow) vixsrcRow.classList.add('dimmed');
						} else { // Master ON
							if (vixsrcRow) vixsrcRow.classList.remove('dimmed');
							vixsrcCb.disabled = !canEnableChildren;
							if (canEnableChildren) {
								if (noPreset && !vixsrcCb.checked) { vixsrcCb.checked = true; }
								else if (storedVixsrcState !== null) { vixsrcCb.checked = storedVixsrcState; storedVixsrcState = null; }
							} else {
								if (storedVixsrcState === null) storedVixsrcState = vixsrcCb.checked;
								vixsrcCb.checked = false;
							}
						}
						if (vixsrcRow) setRowState(vixsrcRow);
					}
					// Sync Local pill availability when VixSrc gating changes
					try { if (typeof updateLocalAvailability === 'function') updateLocalAvailability(); } catch(e) {}

					// CB01 toggle gating (richiede MFP attivo e credenziali come AnimeUnity)
					if (cb01El){
						if (!on) { // Master OFF
							if (storedCb01State === null) storedCb01State = cb01El.checked;
							cb01El.checked = false;
							cb01El.disabled = true;
							if (cb01Row) cb01Row.classList.add('dimmed');
						} else { // Master ON
							if (cb01Row) cb01Row.classList.remove('dimmed');
							cb01El.disabled = !canEnableChildren;
							if (canEnableChildren) {
								if (noPreset && !cb01El.checked) { cb01El.checked = true; }
								else if (storedCb01State !== null) { cb01El.checked = storedCb01State || true; storedCb01State = null; }
							} else {
								if (storedCb01State === null) storedCb01State = cb01El.checked;
								cb01El.checked = false;
							}
						}
						if (cb01Row) setRowState(cb01Row);
					}
				}
				if (mfpMaster){ mfpMaster.addEventListener('change', function(){ syncMfp(); updateLink(); }); syncMfp(); }
				if (mfpUrlInput) { mfpUrlInput.addEventListener('input', function(){ syncMfp(); updateLink(); }); }
				if (mfpPwdInput) { mfpPwdInput.addEventListener('input', function(){ syncMfp(); updateLink(); }); }
				// Local checkbox (direct VixSrc) triggers link update
				try {
					var vixLocalCb = document.getElementById('vixLocal');
					var localPill = document.getElementById('localPill');
					var vixDualCb = document.getElementById('vixDual');
					var dualPill = document.getElementById('dualPill');
					function syncLocalPill(){
						if (localPill && vixLocalCb){
							if (vixLocalCb.checked){ localPill.classList.remove('off'); localPill.classList.add('on'); }
							else { localPill.classList.remove('on'); localPill.classList.add('off'); }
						}
						if (dualPill && vixDualCb){
							if (vixDualCb.checked){ dualPill.classList.remove('off'); dualPill.classList.add('on'); }
							else { dualPill.classList.remove('on'); dualPill.classList.add('off'); }
						}
					}
					function updateLocalAvailability(){
						try {
							var vixsrcToggle = document.getElementById('disableVixsrc');
							var localPillEl = document.getElementById('localPill');
							var localCb = document.getElementById('vixLocal');
							var dualPillEl = document.getElementById('dualPill');
							var dualCb = document.getElementById('vixDual');
							if (!vixsrcToggle) return;
							var providerOn = vixsrcToggle.checked && !vixsrcToggle.disabled; // checked => provider enabled (invert semantics handled elsewhere)
							function handle(elCb, elPill){
								if (!elCb || !elPill) return;
								if (!providerOn){
									elCb.checked = false;
									elCb.disabled = true;
									elPill.classList.add('disabled');
								} else {
									elCb.disabled = false;
									elPill.classList.remove('disabled');
								}
							}
							handle(localCb, localPillEl);
							handle(dualCb, dualPillEl);
							syncLocalPill();
						} catch(e) { console.warn('updateLocalAvailability failed', e); }
					}
					if (vixLocalCb) vixLocalCb.addEventListener('change', function(){ syncLocalPill(); updateLink(); });
					if (vixDualCb) vixDualCb.addEventListener('change', function(){ syncLocalPill(); updateLink(); });
					syncLocalPill();
					updateLocalAvailability();
					var vixsrcToggleEl = document.getElementById('disableVixsrc');
					if (vixsrcToggleEl) vixsrcToggleEl.addEventListener('change', function(){ updateLocalAvailability(); updateLink(); });
				} catch(e) {}
				// Ensure MediaflowProxy block remains right after presets block (already moved earlier) and before provider toggles
				try {
					var presetBlock = document.getElementById('presetInstallations');
					var mediaflowToggle = document.getElementById('mediaflowMaster');
					if (presetBlock && mediaflowToggle){
						var mediaWrap = mediaflowToggle.closest('.form-element');
						var formEl = presetBlock.closest('form');
						if (mediaWrap && formEl){
							var afterPreset = presetBlock.parentNode;
							// Insert mediaWrap immediately after preset container's parent wrapper
							if (afterPreset && afterPreset.nextSibling !== mediaWrap){
								afterPreset.parentNode.insertBefore(mediaWrap, afterPreset.nextSibling);
							}
						}
					}
				} catch(e) { console.warn('Mediaflow reposition failed', e); }
				// Live TV subgroup: show TvTap & Vavoo toggles only if Live TV enabled
				var liveTvToggle = document.getElementById('disableLiveTv'); // invert semantics
				var liveSub = document.getElementById('liveTvSubToggles');
					// Reorder: ensure Live TV appears above VixSrc
					try {
						var vixInput = document.getElementById('disableVixsrc');
						var liveInput = liveTvToggle;
						if (vixInput && liveInput) {
							var vixWrap = vixInput.closest('.form-element');
							var liveWrap = liveInput.closest('.form-element');
							if (vixWrap && liveWrap && vixWrap.previousElementSibling !== liveWrap) {
								vixWrap.parentNode.insertBefore(liveWrap, vixWrap);
							}
						}
					} catch(e) { console.warn(e); }
				// Place liveSub immediately after Live TV toggle container
				if (liveTvToggle && liveSub){
					var liveWrapper = liveTvToggle.closest('.form-element');
					if (liveWrapper && liveWrapper.nextSibling !== liveSub){
						liveWrapper.parentNode.insertBefore(liveSub, liveWrapper.nextSibling);
					}
				}
				var tvtapToggleEl = (function(){ var n=document.getElementById('tvtapProxyEnabled'); return n? n.closest('.form-element'): null; })();
				var vavooToggleEl = (function(){ var n=document.getElementById('vavooNoMfpEnabled'); return n? n.closest('.form-element'): null; })();
				function syncLive(){
						var enabled = liveTvToggle ? liveTvToggle.checked : true; // slider ON means feature ON
					if (liveSub) liveSub.style.display = enabled ? 'block':'none';
					if (tvtapToggleEl) tvtapToggleEl.style.display = enabled ? 'block':'none';
					if (vavooToggleEl) vavooToggleEl.style.display = enabled ? 'block':'none';
					// Ensure they are inside subgroup container for visual grouping
					if (enabled && liveSub){
						if (tvtapToggleEl && tvtapToggleEl.parentElement !== liveSub) liveSub.appendChild(tvtapToggleEl);
						if (vavooToggleEl && vavooToggleEl.parentElement !== liveSub) liveSub.appendChild(vavooToggleEl);
					}
				}
				if (liveTvToggle){ liveTvToggle.addEventListener('change', function(){ syncLive(); updateLink(); }); syncLive(); }
				// Reorder provider toggles in requested order without altering other logic
				try {
					var orderIds = [
						'disableLiveTv',        // Live TV first
						'disableVixsrc',         // VixSrc directly under Live TV block
						'cb01Enabled',           // CB01
						'guardahdEnabled',       // GuardaHD
						'streamingwatchEnabled', // StreamingWatch
						'guardaserieEnabled',    // GuardaSerie
						'eurostreamingEnabled',  // Eurostreaming
						'animeunityEnabled',     // Anime Unity
						'animesaturnEnabled',    // Anime Saturn
						'animeworldEnabled'      // Anime World
					];
					var firstWrapper = null;
					var prev = null;
					orderIds.forEach(function(id){
						var input = document.getElementById(id);
						if (!input) return;
						var wrap = input.closest('.form-element');
						if (!wrap || !wrap.parentNode) return;
						if (!firstWrapper) { firstWrapper = wrap; prev = wrap; return; }
						if (prev && prev.nextSibling !== wrap) {
							prev.parentNode.insertBefore(wrap, prev.nextSibling);
						}
						prev = wrap;
					});
					// Dopo il riordino assicurati che il blocco opzioni Live TV sia subito dopo il toggle Live TV
					try {
						var liveTvToggle2 = document.getElementById('disableLiveTv');
						var liveSub2 = document.getElementById('liveTvSubToggles');
						if (liveTvToggle2 && liveSub2) {
							var liveWrapper2 = liveTvToggle2.closest('.form-element');
							if (liveWrapper2 && liveWrapper2.parentNode && liveWrapper2.nextSibling !== liveSub2) {
								liveWrapper2.parentNode.insertBefore(liveSub2, liveWrapper2.nextSibling);
							}
							// Reinserisci i toggle TvTap e Vavoo dentro il blocco se non presenti
							var tvtapToggleEl2 = (function(){ var n=document.getElementById('tvtapProxyEnabled'); return n? n.closest('.form-element'): null; })();
							var vavooToggleEl2 = (function(){ var n=document.getElementById('vavooNoMfpEnabled'); return n? n.closest('.form-element'): null; })();
							if (tvtapToggleEl2 && tvtapToggleEl2.parentElement !== liveSub2) liveSub2.appendChild(tvtapToggleEl2);
							if (vavooToggleEl2 && vavooToggleEl2.parentElement !== liveSub2) liveSub2.appendChild(vavooToggleEl2);
						}
					} catch(e) { console.warn('LiveTV block reposition after reorder failed', e); }
				} catch(e) { console.warn('Reorder toggles failed', e); }
				// Preset logic
				function applyPreset(name){
					// Base: tutto ON (compresi invertiti) => features abilitate
					var base = {
						disableVixsrc: true,
						disableLiveTv: true,
						cb01Enabled: true,
						guardahdEnabled: true,
						guardaserieEnabled: true,
						eurostreamingEnabled: true,
						streamingwatchEnabled: true,
						animeunityEnabled: true,
						animesaturnEnabled: true,
						animeworldEnabled: true,
						tvtapProxyEnabled: true,
						vavooNoMfpEnabled: true,
						mediaflowMaster: false
					};
					var p = name;
					try { window.__SVX_PRESET = p; } catch(e){}
					if (p==='locale') {
						base.tvtapProxyEnabled = false; // OFF
						base.vavooNoMfpEnabled = false; // OFF
						base.mediaflowMaster = true;    // ON per preset Locale
					} else if (p==='pubblicamfp') {
						base.tvtapProxyEnabled = false;
						base.vavooNoMfpEnabled = false;
						base.eurostreamingEnabled = false;
						base.animeunityEnabled = false;
						base.mediaflowMaster = true;
					} else if (p==='pubblicanomfp') {
						base.disableVixsrc = false; // VixSrc OFF
						base.cb01Enabled = false;
						base.eurostreamingEnabled = false;
						base.animeunityEnabled = false;
					} else if (p==='oci') {
						base.eurostreamingEnabled = false;
						base.animeunityEnabled = false; // resta OFF
						base.mediaflowMaster = true;    // abilita MFP
					}
					Object.keys(base).forEach(function(k){
						var el = document.getElementById(k);
						if (!el) return;
						try { el.checked = !!base[k]; } catch(e){}
						try {
							var evt;
							try { evt = new Event('change', { bubbles:true }); } catch(e2) { evt = document.createEvent('Event'); evt.initEvent('change', true, false); }
							el.dispatchEvent(evt);
						} catch(e3){}
					});
					// Active style on clicked button
					var presetWrap = document.getElementById('presetInstallations');
					if (presetWrap){
						presetWrap.querySelectorAll('.preset-btn').forEach(function(b){ b.classList.remove('active'); });
						var currentBtn = presetWrap.querySelector('[data-preset="'+p+'"]');
						if (currentBtn) currentBtn.classList.add('active');
					}
					// Risincronizza gruppi dipendenti
					if (typeof syncMfp === 'function') try { syncMfp(); } catch(e){}
					if (typeof syncLive === 'function') try { syncLive(); } catch(e){}
					updateLink();
				}
				var presetWrap = document.getElementById('presetInstallations');
				if (presetWrap){
					presetWrap.querySelectorAll('[data-preset]').forEach(function(btn){
						btn.addEventListener('click', function(){
							applyPreset(btn.getAttribute('data-preset'));
						});
					});
				}
				// expose preset for debug
				try { window.applyPreset = applyPreset; } catch(e){}
				// expose globally for bottom script
				window.updateLink = updateLink;
			}
			`
		}
	}

	// Aggiunge la logica per il pulsante "Copia Manifest" allo script
	// Questa logica viene aggiunta indipendentemente dalla presenza di un form di configurazione
	script += `
		console.log('[SVX] Copy manifest setup');
		var copyManifestLink = document.getElementById('copyManifestLink');
		if (copyManifestLink) {
			copyManifestLink.onclick = function () {
				var manifestUrl;
				var mainForm = document.getElementById('mainForm');
				if (mainForm) {
					var config = window.buildConfigFromForm ? window.buildConfigFromForm() : {};
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
		<meta http-equiv="Cache-Control" content="no-cache, no-store, must-revalidate" />
		<meta http-equiv="Pragma" content="no-cache" />
		<meta http-equiv="Expires" content="0" />
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

