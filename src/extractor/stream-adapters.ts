import type { StreamForStremio } from '../types/animeunity';
import { HostExtractor, ExtractResult, ExtractorContext } from './base';

// Lazy import of webstreamr original extractors
async function loadDropload() { const mod = await import('../../webstreamr-main/src/extractor/Dropload'); return mod.Dropload; }
async function loadDood() { const mod = await import('../../webstreamr-main/src/extractor/DoodStream'); return mod.DoodStream; }

interface ShimContextConfig { mediaFlowProxyUrl?: string; }
interface ShimCtx { ip?: string; config: ShimContextConfig; countryCodes?: string[]; }

class SimpleFetcher {
	async text(_ctx: ShimCtx, url: URL): Promise<string> {
		const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'text/html,application/xhtml+xml' } });
		if (!r.ok) throw new Error('fetch fail ' + r.status);
		return await r.text();
	}
	async head(_ctx: ShimCtx, url: URL): Promise<Record<string, string>> { await this.text(_ctx, url); return {}; }
}

abstract class BaseWsAdapter implements HostExtractor {
	abstract id: string;
	protected label = '';
	abstract supports(url: string): boolean;
	protected fetcher = new SimpleFetcher();
	protected formatTwoLine(baseTitle: string, bytes?: number, height?: number): string {
		const segs: string[] = [];
		if (bytes) {
			const units = ['B', 'KB', 'MB', 'GB', 'TB']; let v = bytes; let i = 0; while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
			segs.push((i >= 2 ? v.toFixed(2) : v.toFixed(0)) + units[i]);
		}
		if (height) segs.push(height + 'p');
		segs.push(this.label || this.id);
		return `${baseTitle || this.label} • [ITA]\n💾 ${segs.join(' • ')}`;
	}
	extract(_url: string, _ctx: ExtractorContext): Promise<ExtractResult> { throw new Error('not implemented'); }
}

export class WsDroploadAdapter extends BaseWsAdapter {
	id = 'dropload';
	protected label = 'Dropload';
	supports(url: string) { return /dropload/i.test(url); }
	async extract(rawUrl: string, _ctx: ExtractorContext): Promise<ExtractResult> {
		try {
			const DroploadCls: any = await loadDropload();
			const inst = new DroploadCls(new SimpleFetcher());
			const shimCtx: any = { config: {}, countryCodes: _ctx.countryCode ? [_ctx.countryCode] : ['IT'] };
			const normalized = inst.normalize(new URL(rawUrl));
			const results = await inst.extract(shimCtx, normalized, { countryCodes: shimCtx.countryCodes });
			if (!Array.isArray(results) || !results.length) return { streams: [] };
			const out: StreamForStremio[] = [];
			for (const r of results) {
				if (!r || !r.url) continue;
				const bytes = (r as any).meta?.bytes;
				const height = (r as any).meta?.height;
				const title = (r as any).meta?.title || 'Dropload';
				out.push({ title: this.formatTwoLine(title, bytes, height), url: r.url.href || r.url, behaviorHints: { notWebReady: true } });
			}
			return { streams: out };
		} catch (e) {
			try {
				const url = new URL(rawUrl.replace('/embed-', '/').replace('/e/', '/').replace('/d/', '/'));
				const shimCtx: ShimCtx = { config: {}, countryCodes: ['IT'] };
				const html = await this.fetcher.text(shimCtx, url);
				let packedUrl: string | undefined;
				const broadPacked = html.match(/https?:[^"'\s]+\.m3u8[^"'\s]*/);
				if (broadPacked) packedUrl = broadPacked[0];
				if (!packedUrl) return { streams: [] };
				const title = (html.match(/<h1[^>]*>([^<]+)<\/h1>/)?.[1] || 'Dropload').trim();
				return { streams: [{ title: this.formatTwoLine(title, undefined, undefined), url: packedUrl, behaviorHints: { notWebReady: true } }] };
			} catch { return { streams: [] }; }
		}
	}
}

export class WsDoodAdapter extends BaseWsAdapter {
	id = 'doodstream';
	protected label = 'Doodstream';
	supports(url: string) { return /dood|do[0-9]go|doood|dooood|ds2play|ds2video|d0o0d|do0od|d0000d|d000d|vidply|all3do|doply|vide0|vvide0|d-s/i.test(url); }
	async extract(rawUrl: string, ctx: ExtractorContext): Promise<ExtractResult> {
		try {
			const Cls = await loadDood();
			const videoId = rawUrl.split('/').pop();
			const domains = ['https://dood.to', 'https://doodstream.co'];
			let html = ''; let origin = ''; let cookies: string[] = [];
			for (const d of domains) {
				try { const u = new URL(`/e/${videoId}`, d); const h = await fetch(u, { headers: { 'User-Agent': 'Mozilla/5.0' } }); if (h.ok) { html = await h.text(); origin = d; cookies = (h.headers.get('set-cookie') || '').split(/, (?=[^;]+=)/); break; } } catch { }
			}
			if (!html) return { streams: [] };
			const pass = html.match(/\/pass_md5\/[\w-]+\/([\w-]+)/); if (!pass) return { streams: [] };
			const token = pass[1];
			const passUrl = new URL(pass[0], origin).toString();
			await new Promise(r => setTimeout(r, 900));
			const baseResp = await fetch(passUrl, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: origin, ...(cookies.length ? { Cookie: cookies.map(c => c.split(';')[0]).join('; ') } : {}) } });
			const baseTxt = baseResp.ok ? await baseResp.text() : '';
			if (!baseTxt) return { streams: [] };
			let mp4 = '';
			if (baseTxt.includes('cloudflarestorage')) mp4 = baseTxt.trim(); else mp4 = `${baseTxt}${Math.random().toString(36).slice(2, 12)}?token=${token}&expiry=${Date.now()}`;
			if (ctx.mfpUrl && ctx.mfpPassword) {
				const { formatMediaFlowUrl } = await import('../utils/mediaflow');
				mp4 = formatMediaFlowUrl(mp4, ctx.mfpUrl, ctx.mfpPassword);
			}
			const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
			const title = titleMatch ? titleMatch[1].replace(/ - DoodStream/i, '').trim() : 'Doodstream';
			const stream: StreamForStremio = { title: `${title} • [ITA]\n💾 Doodstream`, url: mp4, behaviorHints: { notWebReady: true } };
			return { streams: [stream] };
		} catch { return { streams: [] }; }
	}
}

