// React Native compatibility layer for web/Capacitor
// Maps RN primitives to HTML elements with style support

import React from "react";

type Style = Record<string, any> | undefined;
type Styles = Record<string, any>;

function flattenStyle(style: any): Record<string, any> {
  if (!style) return {};
  if (Array.isArray(style)) return Object.assign({}, ...style.map(flattenStyle));
  return style;
}

// Convert RN style properties to CSS
function rnToCss(style: any): React.CSSProperties {
  const flat = flattenStyle(style);
  const css: any = {};
  for (const [key, val] of Object.entries(flat)) {
    if (val === undefined) continue;
    switch (key) {
      case "paddingHorizontal":
        css.paddingLeft = val; css.paddingRight = val; break;
      case "paddingVertical":
        css.paddingTop = val; css.paddingBottom = val; break;
      case "marginHorizontal":
        css.marginLeft = val; css.marginRight = val; break;
      case "marginVertical":
        css.marginTop = val; css.marginBottom = val; break;
      default:
        css[key] = val;
    }
  }
  return css;
}

// Strip RN-only props that aren't valid HTML attributes
const RN_ONLY_PROPS = new Set([
  "numberOfLines", "ellipsizeMode", "lineBreakMode", "adjustsFontSizeToFit",
  "paddingHorizontal", "paddingVertical", "marginHorizontal", "marginVertical",
  "keyboardShouldPersistTaps", "blurOnSubmit", "returnKeyType", "autoCorrect",
  "keyboardType", "placeholderTextColor", "onSubmitEditing", "onChangeText",
  "contentContainerStyle", "activeOpacity", "onPress", "multiline",
]);

function cleanProps(props: any): any {
  const clean: any = {};
  for (const [k, v] of Object.entries(props)) {
    if (!RN_ONLY_PROPS.has(k)) clean[k] = v;
  }
  return clean;
}

// --- RN Component Stubs ---

export const View = React.forwardRef<HTMLDivElement, any>((props, ref) => {
  const { style, children, ...rest } = props;
  const css: any = rnToCss(style);
  // RN View is a flex container when any flex props are present
  const hasFlexProps = css.flex !== undefined || css.flexDirection || css.flexGrow !== undefined || css.flexShrink !== undefined || css.flexBasis !== undefined || css.justifyContent || css.alignItems || css.alignSelf || css.flexWrap;
  if (hasFlexProps && !css.display) css.display = "flex";
  if (css.display === "flex" && !css.flexDirection) css.flexDirection = "column";
  return <div ref={ref} style={css} {...cleanProps(rest)}>{children}</div>;
});

export const Text = React.forwardRef<HTMLDivElement, any>((props, ref) => {
  const { style, children, numberOfLines, ...rest } = props;
  const css: any = rnToCss(style);
  // Block display by default so flex/layout works like RN
  if (!css.display) css.display = "block";
  if (numberOfLines === 1) {
    css.overflow = "hidden";
    css.textOverflow = "ellipsis";
    css.whiteSpace = "nowrap";
  }
  return <div ref={ref} style={css} {...cleanProps(rest)}>{children}</div>;
});

export function TextInput(props: any) {
  const {
    style, value, onChangeText, placeholder, placeholderTextColor,
    multiline, autoFocus, numberOfLines, editable, onSubmitEditing,
    blurOnSubmit, returnKeyType, autoCorrect, keyboardType, ...rest
  } = props;

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    onChangeText?.(e.target.value);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !multiline) {
      e.preventDefault();
      onSubmitEditing?.();
    }
    if (e.key === "Enter" && multiline && !e.shiftKey && blurOnSubmit) {
      e.preventDefault();
      onSubmitEditing?.();
    }
  };

  const css: any = {
    ...rnToCss(style),
    outline: "none",
    border: style?.borderWidth ? undefined : "none",
    background: style?.backgroundColor ? rnToCss(style).backgroundColor : "transparent",
    color: style?.color || "inherit",
    fontFamily: "inherit",
    fontSize: "inherit",
    width: "100%",
    boxSizing: "border-box",
    display: "block",
    resize: "none",
  };

  if (multiline) {
    return (
      <textarea
        style={css} value={value} onChange={handleChange} onKeyDown={handleKeyDown}
        placeholder={placeholder} placeholderTextColor={placeholderTextColor}
        autoFocus={autoFocus}
        rows={numberOfLines || 3} disabled={editable === false} {...cleanProps(rest)}
      />
    );
  }

  return (
    <input
      style={css}
      type={keyboardType === "email-address" ? "email" : keyboardType === "numeric" ? "tel" : "text"}
      value={value} onChange={handleChange} onKeyDown={handleKeyDown}
      placeholder={placeholder}
      autoFocus={autoFocus}
      disabled={editable === false}
      {...cleanProps(rest)}
    />
  );
}

export const ScrollView = React.forwardRef<HTMLDivElement, any>((props, ref) => {
  const { style, contentContainerStyle, children, keyboardShouldPersistTaps, ...rest } = props;

  const innerRef = React.useRef<HTMLDivElement>(null);
  React.useImperativeHandle(ref, () => ({
    scrollToEnd: ({ animated }: any = {}) => {
      const el = innerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    },
    scrollTo: ({ y, animated }: any) => {
      const el = innerRef.current;
      if (el) el.scrollTop = y;
    },
  } as any));

  return (
    <div ref={innerRef} style={{ ...rnToCss(style), overflowY: "auto", WebkitOverflowScrolling: "touch" }} {...cleanProps(rest)}>
      <div style={rnToCss(contentContainerStyle)}>{children}</div>
    </div>
  );
});

export function TouchableOpacity(props: any) {
  const { style, onPress, activeOpacity, children, disabled, ...rest } = props;
  return (
    <button
      style={{
        ...rnToCss(style),
        background: style?.backgroundColor ? rnToCss(style).backgroundColor : "none",
        border: "none",
        cursor: disabled ? "default" : "pointer",
        opacity: disabled ? 0.4 : 1,
        padding: style?.padding !== undefined ? undefined : 0,
        font: "inherit",
        color: "inherit",
        touchAction: "manipulation",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={onPress} disabled={disabled} type="button" {...cleanProps(rest)}
    >
      {children}
    </button>
  );
}

export function ActivityIndicator(props: any) {
  const { size = "small", color = "#4a9eff", style } = props;
  const px = size === "small" ? 20 : size === "large" ? 36 : Number(size) || 20;
  return (
    <div style={{ ...rnToCss(style), display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{
        width: px, height: px,
        border: `2px solid ${color}33`, borderTopColor: color,
        borderRadius: "50%", animation: "spin 0.8s linear infinite",
      }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

export const StyleSheet = {
  create<T extends Styles>(styles: T): T { return styles; },
};

export const Platform = {
  OS: "web" as const,
  select: <T,>(obj: Record<string, T>): T => obj.web ?? obj.default ?? Object.values(obj)[0],
};
