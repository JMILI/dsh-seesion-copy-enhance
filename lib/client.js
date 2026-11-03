window.__ModuleLoader__.load({
	id: 'dsh-seesion-copy-enhance',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		let React;
		try {
			React = require('react');
		} catch {
			React = undefined;
		}

		let primitives;
		try {
			primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		} catch {
			primitives = undefined;
		}

		/** Base path of the host bridge registered by this package's host half. */
		const ROUTE = '/dsh-seesion-copy-enhance';

		/** How many captured messages stay resolvable without a host round trip. */
		const MAX_LOCAL_COPIES = 16;

		/** Inline-data budget for the `text/html` clipboard flavour. */
		const MAX_INLINE_HTML_BYTES = 24 * 1024 * 1024;

		/** Client context, kept so the paste path can reach `conversation` lazily. */
		let clientContext;

		/** Composer binding published by the dock component. */
		let bridge;

		/** token -> captured bundle, in copy order. */
		const copies = new Map();

		const STYLES = `
.dsh-sce-toast {
	position: fixed;
	left: 50%;
	bottom: 104px;
	transform: translateX(-50%) translateY(10px);
	max-width: min(72vw, 560px);
	padding: 9px 15px;
	border-radius: 10px;
	font-size: 13px;
	line-height: 1.45;
	color: var(--dsh-color-text-primary, #f3f3f3);
	background: var(--dsh-color-surface-overlay, rgba(30, 30, 32, 0.94));
	box-shadow: 0 10px 28px rgba(0, 0, 0, 0.32);
	border: 1px solid rgba(255, 255, 255, 0.08);
	opacity: 0;
	pointer-events: none;
	transition: opacity 160ms ease, transform 160ms ease;
	z-index: 2147483000;
}
.dsh-sce-toast[data-show="true"] {
	opacity: 1;
	transform: translateX(-50%) translateY(0);
}
.dsh-sce-toast[data-tone="error"] { color: #ffb3b3; }
.dsh-sce-toast[data-tone="success"] { color: #b8f2c5; }
`

		/** Install the plugin on the client context. */
		const apply = (ctx) => {
			clientContext = ctx;
			ctx.effect(() => installStyles(), 'dsh-seesion-copy-enhance: styles');
			ctx.effect(() => installListeners(), 'dsh-seesion-copy-enhance: clipboard listeners');
			ctx.slots.inject('conversation.composer.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.composer.dock',
						id: 'dsh-seesion-copy-enhance',
						order: 60,
					},
					BridgeDock,
				),
			);
		};

		/**
		 * Invisible dock occupant: it exists only to receive the composer's
		 * `sessionId` and `inputActions`, which the clipboard listeners need.
		 * @param props - standard composer dock props.
		 * @returns null.
		 */
		function BridgeDock(props) {
			if (React === undefined) return null;
			const sessionId = props?.sessionId;
			const inputActions = props?.inputActions;
			React.useEffect(() => {
				if (sessionId === undefined || inputActions === undefined) return undefined;
				bridge = { sessionId, inputActions };
				return () => {
					if (bridge !== undefined && bridge.sessionId === sessionId) bridge = undefined;
				};
			}, [sessionId, inputActions]);
			return null;
		}

		/** Append the toast stylesheet and remove it when the plugin unloads. */
		function installStyles() {
			if (typeof document === 'undefined') return () => {};
			const node = document.createElement('style');
			node.dataset.dshSeesionCopyEnhance = 'toast';
			node.textContent = STYLES;
			document.head.appendChild(node);
			return () => node.remove();
		}

		/** Attach the document-level copy/paste interception. */
		function installListeners() {
			if (typeof document === 'undefined') return () => {};
			const onClick = (event) => {
				void interceptCopy(event);
			};
			const onPaste = (event) => {
				interceptPaste(event);
			};
			document.addEventListener('click', onClick, true);
			document.addEventListener('paste', onPaste, true);
			return () => {
				document.removeEventListener('click', onClick, true);
				document.removeEventListener('paste', onPaste, true);
			};
		}

		// ------------------------------------------------------------------
		// copy
		// ------------------------------------------------------------------

		/**
		 * Recognise a click on the native user-message copy button and replace the
		 * text-only clipboard write with a complete capture of the message.
		 * @param event - the captured click.
		 */
		async function interceptCopy(event) {
			const target = event.target;
			if (!(target instanceof Element)) return;
			if (bridge === undefined) return;
			const row = target.closest('[data-clock="start"]');
			if (row === null) return;
			const copyButton = row.querySelector('button');
			if (copyButton === null) return;
			if (copyButton !== target && !copyButton.contains(target)) return;
			const node = row.closest('[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"]');
			if (node === null) return;

			event.preventDefault();
			event.stopImmediatePropagation();

			const visibleText = messageTextOf(node);
			const request = {
				sessionId: bridge.sessionId,
				seq: seqOf(node),
				fromEnd: distanceFromEnd(node),
				text: visibleText,
			};
			const captured = postJson('/capture', request)
				.then((response) => {
					if (response === undefined || response.ok !== true) return undefined;
					const bundle = {
						token: response.token,
						text: typeof response.text === 'string' && response.text !== '' ? response.text : visibleText,
						attachments: Array.isArray(response.attachments) ? response.attachments : [],
						warnings: Array.isArray(response.warnings) ? response.warnings : [],
					};
					remember(bundle);
					return bundle;
				})
				.catch((error) => {
					console.warn('[dsh-seesion-copy-enhance] capture failed', error);
					return undefined;
				});

			// Start the clipboard write inside the click gesture, then let its HTML
			// flavour wait for the capture: an `await` first would spend the
			// activation that `clipboard.write` needs.
			const gesture = writeDuringGesture(visibleText, captured);
			if (gesture !== undefined) {
				const written = await gesture;
				const bundle = await captured;
				if (written === true) {
					announce(bundle, visibleText);
					return;
				}
			}

			const bundle = await captured;
			if (bundle === undefined) {
				const plain = await writePlainText(visibleText);
				toast(plain ? '已复制文字（没有取到附件）' : '无法写入剪贴板，请检查剪贴板权限', plain ? 'info' : 'error');
				return;
			}
			const written = await writeBundle(bundle);
			if (written !== true) {
				toast('无法写入剪贴板，请检查剪贴板权限', 'error');
				return;
			}
			announce(bundle, visibleText);
		}

		/** Report what landed on the clipboard after a successful copy. */
		function announce(bundle, visibleText) {
			if (bundle === undefined) {
				toast(visibleText === '' ? '已复制（未取到附件与文字，请检查 Host 是否在线）' : '已复制文字（未取到附件）', 'info');
				return;
			}
			const media = bundle.attachments.length;
			toast(
				media === 0 ? '已复制文字（这条消息没有附件）' : `已复制文字 + ${media} 个附件，可粘贴到任意会话`,
				'success',
			);
			if (bundle.warnings.length > 0) console.warn('[dsh-seesion-copy-enhance]', bundle.warnings);
		}

		/** Read a user message's visible text without the clock and attachment row. */
		function messageTextOf(node) {
			const clone = node.cloneNode(true);
			for (const chrome of clone.querySelectorAll('[data-clock], [data-message-attachments]')) chrome.remove();
			const text = clone.innerText ?? clone.textContent ?? '';
			return text.trim();
		}

		/** Parse the chat node key as an event sequence when it encodes one. */
		function seqOf(node) {
			const key = node.getAttribute('data-chat-node-key') ?? '';
			const match = /(\d+)(?![\s\S]*\d)/.exec(key);
			return match === null ? -1 : Number(match[1]);
		}

		/** How many user messages sit after this one on screen (0 = the latest). */
		function distanceFromEnd(node) {
			const rows = Array.from(document.querySelectorAll('[data-chat-flow-kind="user"]'));
			const index = rows.indexOf(node);
			return index < 0 ? -1 : rows.length - 1 - index;
		}

		/** Remember one captured bundle and evict the oldest. */
		function remember(bundle) {
			if (typeof bundle.token !== 'string' || bundle.token === '') return;
			copies.delete(bundle.token);
			copies.set(bundle.token, bundle);
			while (copies.size > MAX_LOCAL_COPIES) {
				const oldest = copies.keys().next();
				if (oldest.done === true) break;
				copies.delete(oldest.value);
			}
		}

		/**
		 * Build a clipboard item while the click gesture is still live.
		 *
		 * The pending capture is handed over as a promise, which the async
		 * Clipboard API accepts, so the write request itself stays synchronous.
		 * @param text - the visible message text, known immediately.
		 * @param captured - promise of the full bundle, or `undefined` on failure.
		 * @returns a promise of `true` on success, or `undefined` when the async
		 * clipboard is unavailable.
		 */
		function writeDuringGesture(text, captured) {
			const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
			if (clipboard === undefined) return undefined;
			if (typeof ClipboardItem === 'undefined' || typeof clipboard.write !== 'function') return undefined;
			try {
				const plain = text === '' ? ' ' : text;
				const item = new ClipboardItem({
					'text/plain': Promise.resolve(new Blob([plain], { type: 'text/plain' })),
					'text/html': captured.then((bundle) =>
						new Blob([bundle === undefined ? `<div>${escapeHtml(plain)}</div>` : htmlOf(bundle)], {
							type: 'text/html',
						}),
					),
				});
				return clipboard.write([item]).then(
					() => true,
					(error) => {
						console.warn('[dsh-seesion-copy-enhance] clipboard.write rejected', error);
						return false;
					},
				);
			} catch (error) {
				console.warn('[dsh-seesion-copy-enhance] clipboard.write unavailable', error);
				return undefined;
			}
		}

		/** Write text plus an HTML flavour carrying the media token. */
		async function writeBundle(bundle) {
			const html = htmlOf(bundle);
			const text = bundle.text === '' ? ' ' : bundle.text;
			const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
			if (clipboard !== undefined && typeof ClipboardItem !== 'undefined' && typeof clipboard.write === 'function') {
				try {
					await clipboard.write([
						new ClipboardItem({
							'text/plain': new Blob([text], { type: 'text/plain' }),
							'text/html': new Blob([html], { type: 'text/html' }),
						}),
					]);
					return true;
				} catch {
					// the gesture or permission may be gone; try the DOM copy path
				}
			}
			if (copyRichSelection(html)) return true;
			return writePlainText(text);
		}

		/** Copy a temporary rich selection through the legacy `execCommand` path. */
		function copyRichSelection(html) {
			if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
			const holder = document.createElement('div');
			holder.setAttribute('contenteditable', 'true');
			holder.style.position = 'fixed';
			holder.style.left = '-9999px';
			holder.style.top = '0';
			holder.innerHTML = html;
			document.body.appendChild(holder);
			try {
				const range = document.createRange();
				range.selectNodeContents(holder);
				const selection = window.getSelection();
				if (selection === null) return false;
				selection.removeAllRanges();
				selection.addRange(range);
				return document.execCommand('copy') === true;
			} catch {
				return false;
			} finally {
				holder.remove();
				window.getSelection()?.removeAllRanges();
			}
		}

		/** Fallback clipboard write that keeps the text pasteable. */
		async function writePlainText(text) {
			const value = typeof text === 'string' && text !== '' ? text : ' ';
			const clipboard = typeof navigator === 'undefined' ? undefined : navigator.clipboard;
			if (clipboard !== undefined && typeof clipboard.writeText === 'function') {
				try {
					await clipboard.writeText(value);
					return true;
				} catch {
					// keep falling back
				}
			}
			if (typeof primitives !== 'undefined' && typeof primitives.writeClipboard === 'function') {
				try {
					const ok = await primitives.writeClipboard(value);
					if (ok === true) return true;
				} catch {
					// give up
				}
			}
			return false;
		}

		/** Build the HTML clipboard flavour: text, inline images, and the media token. */
		function htmlOf(bundle) {
			const parts = [];
			parts.push(`<div data-dsh-seesion-copy-enhance="1" data-dsh-sce-token="${escapeAttr(bundle.token)}">`);
			parts.push(`<pre style="white-space:pre-wrap;margin:0">${escapeHtml(bundle.text)}</pre>`);
			let budget = MAX_INLINE_HTML_BYTES;
			for (const attachment of bundle.attachments) {
				if (attachment.kind === 'image' && typeof attachment.data === 'string' && attachment.data.length < budget) {
					budget -= attachment.data.length;
					const src = `data:${attachment.mediaType ?? 'image/png'};base64,${attachment.data}`;
					parts.push(`<p style="margin:8px 0 0"><img src="${src}" alt="${escapeAttr(attachment.name)}" /></p>`);
				} else {
					parts.push(`<p style="margin:8px 0 0">[附件] ${escapeHtml(attachment.name)}</p>`);
				}
			}
			parts.push('</div>');
			parts.push(`<!--dsh-sce-token:${escapeAttr(bundle.token)}-->`);
			return parts.join('');
		}

		// ------------------------------------------------------------------
		// paste
		// ------------------------------------------------------------------

		/**
		 * Restore a captured message into the composer when the clipboard carries
		 * our marker or an exactly matching text-only copy.
		 * @param event - the captured paste.
		 */
		function interceptPaste(event) {
			if (bridge === undefined) return;
			const actions = bridge.inputActions;
			// Without a text-insertion facade the composer's own paste is better
			// than a swallowed event, so leave the clipboard alone.
			if (typeof actions?.insertText !== 'function' && typeof actions?.setDraft !== 'function') return;
			const data = event.clipboardData;
			if (data === undefined || data === null) return;
			if (!isTextEntry(event.target)) return;
			const items = typeof data.items === 'object' && data.items !== null ? Array.from(data.items) : [];
			if (items.some((item) => item.kind === 'file')) return;
			const html = safeGetData(data, 'text/html');
			const text = safeGetData(data, 'text/plain');
			const marker = /dsh-sce-token["']?\s*[:=]\s*["']?([A-Za-z0-9_.-]+)/.exec(html);
			if (marker === null) {
				const known = lookupByText(text);
				if (known === undefined) return;
				event.preventDefault();
				event.stopImmediatePropagation();
				void restore(known);
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			const remembered = copies.get(marker[1]);
			if (remembered !== undefined) {
				void restore(remembered);
				return;
			}
			void restoreByToken(marker[1]);
		}

		/** True when a paste lands in the composer instead of, say, a search box. */
		function isTextEntry(target) {
			if (!(target instanceof Element)) return false;
			if (target.isContentEditable === true) return true;
			if (target.closest('[contenteditable="true"]') !== null) return true;
			if (target.closest('textarea') !== null) return true;
			const input = target.closest('input');
			if (input === null) return false;
			const type = (input.getAttribute('type') ?? 'text').toLowerCase();
			return type === 'text' || type === 'search' || type === '';
		}

		/** Look up a captured bundle by its normalized text, for text-only clipboards. */
		function lookupByText(text) {
			const normalized = normalizeText(text);
			if (normalized === '') return undefined;
			for (const bundle of copies.values()) {
				if (normalizeText(bundle.text) === normalized) return bundle;
			}
			return undefined;
		}

		/** Ask the host for a bundle that this page no longer remembers. */
		async function restoreByToken(token) {
			try {
				const response = await postJson('/resolve', { token });
				if (response === undefined || response.ok !== true) {
					toast('剪贴板里的附件已经失效，只能粘贴文字', 'error');
					return;
				}
				const bundle = {
					token: response.token,
					text: typeof response.text === 'string' ? response.text : '',
					attachments: Array.isArray(response.attachments) ? response.attachments : [],
				};
				remember(bundle);
				await restore(bundle);
			} catch (error) {
				toast(`粘贴增强失败：${messageOf(error)}`, 'error');
			}
		}

		/** Insert the captured text and re-create its images/files as real drafts. */
		async function restore(bundle) {
			const current = bridge;
			if (current === undefined) {
				toast('没有找到输入框，请先点开会话输入区再粘贴', 'error');
				return;
			}
			const files = [];
			for (const attachment of bundle.attachments) {
				const file = toFile(attachment);
				if (file !== undefined) files.push(file);
			}
			let attached = 0;
			if (files.length > 0) {
				const conversation = conversationService();
				if (conversation === undefined || typeof conversation.createDrafts !== 'function') {
					toast('当前界面无法重建附件，只粘贴了文字', 'error');
				} else {
					let drafts = [];
					try {
						drafts = conversation.createDrafts(current.sessionId, files);
					} catch (error) {
						toast(`附件无法加入：${messageOf(error)}`, 'error');
						drafts = [];
					}
					const ids = drafts.map((draft) => draft.id).filter((id) => typeof id === 'string');
					if (ids.length > 0) {
						if (typeof current.inputActions.addAttachments !== 'function') {
							if (typeof conversation.releaseDraftAttachments === 'function') conversation.releaseDraftAttachments(drafts);
							toast('当前界面无法接收附件，只粘贴了文字', 'error');
						} else if (current.inputActions.addAttachments(ids) === true) attached = ids.length;
						else if (typeof conversation.releaseDraftAttachments === 'function') conversation.releaseDraftAttachments(drafts);
					}
				}
			}
			if (typeof bundle.text === 'string' && bundle.text !== '') {
				const inserted = insertText(current, bundle.text);
				if (inserted !== true) toast('文字插入被忽略，请重试', 'error');
			}
			toast(attached === 0 ? '已粘贴文字' : `已粘贴文字 + ${attached} 个附件`, 'success');
		}

		/**
		 * Insert text through whichever input facade the running build exposes.
		 * `insertText(text, span)` is the current seam; `setDraft` is the older,
		 * coarser one, so a build without the caret API still receives the text.
		 * @param current - the live bridge record.
		 * @param text - text to insert.
		 * @returns true when some facade accepted it.
		 */
		function insertText(current, text) {
			const actions = current.inputActions;
			if (typeof actions?.insertText === 'function') {
				const span = typeof actions.captureInsertion === 'function' ? actions.captureInsertion() : undefined;
				try {
					return actions.insertText(text, span) === true;
				} catch (error) {
					console.warn('[dsh-seesion-copy-enhance] insertText failed', error);
				}
			}
			if (typeof actions?.setDraft === 'function') {
				try {
					actions.setDraft(text);
					return true;
				} catch (error) {
					console.warn('[dsh-seesion-copy-enhance] setDraft failed', error);
				}
			}
			return false;
		}

		/** Reach the conversation service that owns draft attachments. */
		function conversationService() {
			const ctx = clientContext;
			if (ctx === undefined) return undefined;
			if (typeof ctx.get === 'function') {
				const service = ctx.get('conversation');
				if (service !== undefined && service !== null) return service;
			}
			return ctx.conversation;
		}

		/** Rebuild one browser File from a captured base64 attachment. */
		function toFile(attachment) {
			if (attachment === undefined || attachment === null || typeof attachment.data !== 'string') return undefined;
			try {
				const binary = atob(attachment.data);
				const bytes = new Uint8Array(binary.length);
				for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
				const name = typeof attachment.name === 'string' && attachment.name !== '' ? attachment.name : 'attachment.bin';
				const type =
					typeof attachment.mediaType === 'string' && attachment.mediaType !== ''
						? attachment.mediaType
						: 'application/octet-stream';
				return new File([bytes], name, { type });
			} catch (error) {
				console.warn('[dsh-seesion-copy-enhance] attachment rebuild failed', error);
				return undefined;
			}
		}

		// ------------------------------------------------------------------
		// bridge + helpers
		// ------------------------------------------------------------------

		/** POST one JSON payload to the host bridge. */
		async function postJson(path, payload) {
			const response = await fetch(`${ROUTE}${path}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(payload),
			});
			if (!response.ok) return undefined;
			return response.json();
		}

		/** Read one clipboard flavour without letting a browser refusal throw. */
		function safeGetData(data, type) {
			try {
				return data.getData(type) ?? '';
			} catch {
				return '';
			}
		}

		/** Collapse whitespace exactly like the host does. */
		function normalizeText(text) {
			return String(text ?? '')
				.replace(/\r\n?/g, '\n')
				.replace(/[ \t\u00a0]+/g, ' ')
				.replace(/\n{2,}/g, '\n')
				.trim();
		}

		/** Escape text for HTML output. */
		function escapeHtml(text) {
			return String(text ?? '')
				.replace(/&/g, '&amp;')
				.replace(/</g, '&lt;')
				.replace(/>/g, '&gt;');
		}

		/** Escape text for an HTML attribute. */
		function escapeAttr(text) {
			return escapeHtml(text).replace(/"/g, '&quot;');
		}

		/** Readable message from an unknown thrown value. */
		function messageOf(error) {
			if (error instanceof Error) return error.message;
			return String(error);
		}

		/** Show a transient toast above the composer. */
		function toast(message, tone) {
			if (typeof document === 'undefined') return undefined;
			let node = document.querySelector('.dsh-sce-toast');
			if (node === null) {
				node = document.createElement('div');
				node.className = 'dsh-sce-toast';
				document.body.appendChild(node);
			}
			node.textContent = message;
			node.dataset.tone = tone ?? 'info';
			node.dataset.show = 'true';
			if (toast.timer !== undefined) window.clearTimeout(toast.timer);
			toast.timer = window.setTimeout(() => {
				if (node !== null) node.dataset.show = 'false';
			}, 2800);
			return undefined;
		}

		exports.apply = apply;
		exports.inject = ['slots'];
		return module.exports;
	},
});
