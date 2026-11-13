import { yaml as yamlLanguage } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { EditorState, RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView } from "@codemirror/view";
import { tags } from "@lezer/highlight";
import { useEffect, useRef } from "react";
import { FreshLines, changedRange } from "./yamlDiff";

// The model as YAML, read-only for now, with new lines highlighted for a few
// seconds and the latest change kept in view. It's CodeMirror so that editing
// can be switched on later.

const HIGHLIGHT_MS = 4000;

const setFresh = StateEffect.define<number[]>();
const freshLine = Decoration.line({ class: "cm-fresh" });

const freshLines = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(decorations, transaction) {
    for (const effect of transaction.effects) {
      if (!effect.is(setFresh)) continue;
      const builder = new RangeSetBuilder<Decoration>();
      for (const number of effect.value) {
        if (number > transaction.state.doc.lines) break;
        const line = transaction.state.doc.line(number);
        builder.add(line.from, line.from, freshLine);
      }
      return builder.finish();
    }
    return decorations.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const highlightStyle = HighlightStyle.define([
  { tag: tags.propertyName, color: "var(--yaml-key)" },
  { tag: [tags.content, tags.string], color: "var(--yaml-value)" },
  { tag: [tags.separator, tags.brace, tags.punctuation], color: "var(--text-muted)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", fontSize: "13px", lineHeight: "1.65" },
  ".cm-content": { padding: "12px 0", caretColor: "transparent" },
  ".cm-line": { padding: "0 16px", transition: "background-color 800ms ease" },
  ".cm-line.cm-fresh": { backgroundColor: "var(--fresh)", transition: "none" },
});

export function YamlView({ yaml }: { yaml: string }) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const fresh = useRef(new FreshLines(HIGHLIGHT_MS));

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current ?? undefined,
      state: EditorState.create({
        extensions: [
          yamlLanguage(),
          syntaxHighlighting(highlightStyle),
          freshLines,
          theme,
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          EditorView.contentAttributes.of({ "aria-label": "Model YAML" }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, []);

  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const change = changedRange(editor.state.doc.toString(), yaml);
    if (change) editor.dispatch({ changes: change });

    const highlight = (scroll: boolean): boolean => {
      const lines = fresh.current.update(yaml, Date.now());
      const last = lines.at(-1);
      const effects: StateEffect<unknown>[] = [setFresh.of(lines)];
      if (scroll && last !== undefined) effects.push(EditorView.scrollIntoView(editor.state.doc.line(last).from, { y: "nearest" }));
      editor.dispatch({ effects });
      return lines.length > 0;
    };
    if (!highlight(change !== undefined)) return;
    // Once the highlights have expired, draw the lines plain again.
    const fade = setTimeout(() => highlight(false), HIGHLIGHT_MS);
    return () => clearTimeout(fade);
  }, [yaml]);

  return <div className="yaml-view" ref={host} />;
}
