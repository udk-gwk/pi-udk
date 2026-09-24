/**
 * Small boxed form for ctx.ui.custom(): one or more single-line fields, optionally masked.
 *
 * pi-tui's Input has no masking option and pi's extension prompts are plain text, so the
 * UdK password and API-key paste go through this. Secret values live only in this closure and
 * the object handed to done(); they are never rendered, logged or stored by the form.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	CURSOR_MARKER,
	type Focusable,
	Key,
	type TUI,
	decodeKittyPrintable,
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

export interface FormField {
	id: string;
	label: string;
	secret?: boolean;
	placeholder?: string;
	initial?: string;
	/** Return an error message to block submit. */
	validate?: (value: string) => string | undefined;
}

export interface FormOptions {
	title: string;
	intro?: string[];
	fields: FormField[];
	/** Shown under the fields, e.g. the previous attempt's error. */
	error?: string;
	footer?: string;
}

export type FormResult = Record<string, string>;

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

function isPrintable(text: string): boolean {
	return ![...text].some((ch) => {
		const c = ch.codePointAt(0) ?? 0;
		return c < 32 || c === 0x7f || (c >= 0x80 && c <= 0x9f);
	});
}

export function createForm(
	tui: TUI,
	theme: Theme,
	options: FormOptions,
	done: (result: FormResult | null) => void,
): Component & Focusable & { dispose(): void } {
	const values = options.fields.map((f) => f.initial ?? "");
	let index = Math.max(
		0,
		values.findIndex((v) => v === ""),
	);
	let error = options.error;
	let pasting = false;
	let pasteBuffer = "";
	let focused = false;
	let finished = false;

	const wipe = () => {
		options.fields.forEach((f, i) => {
			if (f.secret) values[i] = "";
		});
	};

	const finish = (result: FormResult | null) => {
		if (finished) return;
		finished = true;
		done(result);
		wipe();
	};

	const insert = (text: string) => {
		// single-line fields: keep printable chars only (drops newlines from pastes)
		values[index] += [...text].filter((ch) => isPrintable(ch)).join("");
		error = undefined;
	};

	const submit = () => {
		const field = options.fields[index];
		const problem = field.validate?.(values[index]) ?? (values[index].trim() ? undefined : `${field.label} is empty.`);
		if (problem) {
			error = problem;
			return;
		}
		if (index < options.fields.length - 1) {
			index++;
			return;
		}
		for (let i = 0; i < options.fields.length; i++) {
			const f = options.fields[i];
			const p = f.validate?.(values[i]) ?? (values[i].trim() ? undefined : `${f.label} is empty.`);
			if (p) {
				index = i;
				error = p;
				return;
			}
		}
		const result: FormResult = {};
		options.fields.forEach((f, i) => {
			result[f.id] = f.secret ? values[i] : values[i].trim();
		});
		finish(result);
	};

	const move = (delta: number) => {
		const n = options.fields.length;
		index = (index + delta + n) % n;
	};

	const handleInput = (data: string) => {
		if (finished) return;
		if (pasting || data.includes(PASTE_START)) {
			let chunk = data;
			if (!pasting) {
				pasting = true;
				chunk = chunk.slice(chunk.indexOf(PASTE_START) + PASTE_START.length);
			}
			const end = chunk.indexOf(PASTE_END);
			if (end === -1) {
				pasteBuffer += chunk;
			} else {
				pasteBuffer += chunk.slice(0, end);
				insert(pasteBuffer);
				pasteBuffer = "";
				pasting = false;
			}
			tui.requestRender();
			return;
		}

		if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			finish(null);
			return;
		}
		if (matchesKey(data, Key.enter)) submit();
		else if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.up)) move(-1);
		else if (matchesKey(data, Key.tab) || matchesKey(data, Key.down)) move(1);
		else if (matchesKey(data, Key.backspace)) values[index] = [...values[index]].slice(0, -1).join("");
		else if (matchesKey(data, Key.ctrl("u"))) values[index] = "";
		else {
			const printable = decodeKittyPrintable(data) ?? data;
			if (printable && isPrintable(printable)) insert(printable);
		}
		tui.requestRender();
	};

	const render = (width: number): string[] => {
		const w = Math.max(24, width);
		const inner = w - 4;
		const border = (s: string) => theme.fg("borderAccent", s);
		const row = (s: string) => {
			const t = truncateToWidth(s, inner);
			return `${border("│")} ${t}${" ".repeat(Math.max(0, inner - visibleWidth(t)))} ${border("│")}`;
		};
		const lines: string[] = [border(`╭${"─".repeat(w - 2)}╮`), row(theme.bold(theme.fg("accent", options.title)))];
		if (options.intro?.length) {
			lines.push(row(""));
			for (const para of options.intro) {
				if (!para) lines.push(row(""));
				else for (const l of wrapTextWithAnsi(para, inner)) lines.push(row(l));
			}
		}
		lines.push(row(""));

		const labelWidth = Math.max(...options.fields.map((f) => visibleWidth(f.label))) + 2;
		options.fields.forEach((f, i) => {
			const active = i === index;
			const shown = f.secret ? "•".repeat([...values[i]].length) : values[i];
			const room = Math.max(4, inner - labelWidth - 3);
			const chars = [...shown];
			const visible = chars.length > room ? `…${chars.slice(-(room - 1)).join("")}` : shown;
			const body = visible || theme.fg("dim", f.placeholder ?? "");
			const cursor = active && focused ? CURSOR_MARKER : "";
			const marker = active ? theme.fg("accent", "› ") : "  ";
			const label = theme.fg(active ? "accent" : "muted", f.label.padEnd(labelWidth));
			lines.push(row(`${marker}${label}${visible ? body : ""}${cursor}${visible ? "" : body}`));
		});
		lines.push(row(""));
		if (error) {
			for (const l of wrapTextWithAnsi(theme.fg("error", error), inner)) lines.push(row(l));
			lines.push(row(""));
		}
		const hint =
			options.footer ?? (options.fields.length > 1 ? "Enter next/submit · Tab switch field · Esc cancel" : "Enter submit · Esc cancel");
		lines.push(row(theme.fg("dim", hint)));
		lines.push(border(`╰${"─".repeat(w - 2)}╯`));
		return lines;
	};

	return {
		get focused() {
			return focused;
		},
		set focused(v: boolean) {
			focused = v;
		},
		render,
		handleInput,
		invalidate() {},
		dispose: wipe,
	};
}
