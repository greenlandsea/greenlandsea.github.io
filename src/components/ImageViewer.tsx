import React, { useEffect, useMemo, useState } from "react";
import { withBase } from "../lib/paths";

export default function ImageViewer(props: {
  srcs: string[];
  alt: string;
  missingHint?: string;
  opacity?: number;
}) {
  const [tryIndex, setTryIndex] = useState(0);

  useEffect(() => {
    setTryIndex(0);
  }, [props.srcs.join("|")]);

  const currentSrc = props.srcs[tryIndex];
  const resolvedSrc = useMemo(
    () => (currentSrc ? withBase(currentSrc) : ""),
    [currentSrc]
  );

  if (!currentSrc) {
    return (
      <div className="imgWrap">
        <div className="missing">
          <div style={{ fontWeight: 700, marginBottom: 6 }}>Image not found</div>
          <div style={{ marginBottom: 8 }}>{props.missingHint ?? "Drop a PNG/SVG at the expected path."}</div>
          <div style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, Liberation Mono, monospace" }}>
            Tried:
            <div style={{ marginTop: 6 }}>
              {props.srcs.map((s) => (
                <div key={s}>{s}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="imgWrap">
      <img
        src={resolvedSrc}
        alt={props.alt}
        onError={() => setTryIndex((i) => i + 1)}
        loading="lazy"
        style={{ opacity: props.opacity ?? 1 }}
      />
    </div>
  );
}
