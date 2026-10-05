/**
 * OFFLINE TYPE SHIM — a faithful subset of @types/react 19, used ONLY by tsconfig.*.offline.json
 * so renderer code can be typechecked where npm is unavailable. CI/real builds use the real
 * @types/react. If code needs an API missing here, add it with the exact @types/react signature.
 */
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-object-type */

export = React;
export as namespace React;

declare namespace React {
  type Key = string | number | bigint;
  type ReactText = string | number;

  interface ReactElement<P = any, T extends string | JSXElementConstructor<any> = string | JSXElementConstructor<any>> {
    type: T;
    props: P;
    key: string | null;
  }
  type JSXElementConstructor<P> = ((props: P) => ReactNode) | (new (props: P) => Component<any, any>);

  interface ReactPortal extends ReactElement {
    children: ReactNode;
  }
  type ReactNode =
    | ReactElement
    | string
    | number
    | bigint
    | Iterable<ReactNode>
    | ReactPortal
    | boolean
    | null
    | undefined
    | Promise<ReactNode>;

  // ── Refs ──
  interface RefObject<T> {
    current: T;
  }
  type MutableRefObject<T> = RefObject<T>;
  type RefCallback<T> = (instance: T | null) => void | (() => void);
  type Ref<T> = RefCallback<T> | RefObject<T | null> | null;
  type LegacyRef<T> = Ref<T>;
  type ForwardedRef<T> = ((instance: T | null) => void) | RefObject<T | null> | null;

  // ── Components ──
  type PropsWithChildren<P = unknown> = P & { children?: ReactNode | undefined };
  type PropsWithRef<P> = P;

  interface FunctionComponent<P = {}> {
    (props: P): ReactNode | Promise<ReactNode>;
    displayName?: string | undefined;
  }
  type FC<P = {}> = FunctionComponent<P>;

  interface ComponentClass<P = {}, S = any> {
    new (props: P): Component<P, S>;
    displayName?: string | undefined;
    contextType?: Context<any> | undefined;
    getDerivedStateFromError?: (error: any) => Partial<S> | null;
    getDerivedStateFromProps?: (props: Readonly<P>, state: S) => Partial<S> | null;
  }
  type ComponentType<P = {}> = ComponentClass<P> | FunctionComponent<P>;
  type ElementType<P = any> =
    | { [K in keyof JSX.IntrinsicElements]: P extends JSX.IntrinsicElements[K] ? K : never }[keyof JSX.IntrinsicElements]
    | ComponentType<P>;

  interface ErrorInfo {
    componentStack?: string | null;
    digest?: string | null;
  }

  class Component<P = {}, S = {}> {
    static contextType?: Context<any> | undefined;
    context: unknown;
    constructor(props: P);
    readonly props: Readonly<P>;
    state: Readonly<S>;
    setState<K extends keyof S>(
      state: ((prevState: Readonly<S>, props: Readonly<P>) => Pick<S, K> | S | null) | (Pick<S, K> | S | null),
      callback?: () => void,
    ): void;
    forceUpdate(callback?: () => void): void;
    render(): ReactNode;
    componentDidMount?(): void;
    shouldComponentUpdate?(nextProps: Readonly<P>, nextState: Readonly<S>): boolean;
    componentWillUnmount?(): void;
    componentDidCatch?(error: Error, errorInfo: ErrorInfo): void;
    componentDidUpdate?(prevProps: Readonly<P>, prevState: Readonly<S>): void;
  }
  class PureComponent<P = {}, S = {}> extends Component<P, S> {}

  type ComponentProps<T extends keyof JSX.IntrinsicElements | JSXElementConstructor<any>> =
    T extends JSXElementConstructor<infer Props> ? Props : T extends keyof JSX.IntrinsicElements ? JSX.IntrinsicElements[T] : {};
  type ComponentPropsWithRef<T extends ElementType> = ComponentProps<T & (keyof JSX.IntrinsicElements | JSXElementConstructor<any>)>;
  type ComponentPropsWithoutRef<T extends ElementType> = Omit<ComponentProps<T & (keyof JSX.IntrinsicElements | JSXElementConstructor<any>)>, 'ref'>;

  // ── Context ──
  interface ProviderProps<T> {
    value: T;
    children?: ReactNode | undefined;
  }
  interface ConsumerProps<T> {
    children: (value: T) => ReactNode;
  }
  type Provider<T> = FunctionComponent<ProviderProps<T>>;
  type Consumer<T> = FunctionComponent<ConsumerProps<T>>;
  interface Context<T> extends Provider<T> {
    Provider: Provider<T>;
    Consumer: Consumer<T>;
    displayName?: string | undefined;
  }
  function createContext<T>(defaultValue: T): Context<T>;

  // ── Hooks ──
  type SetStateAction<S> = S | ((prevState: S) => S);
  type Dispatch<A> = (value: A) => void;
  type DispatchWithoutAction = () => void;
  type Reducer<S, A> = (prevState: S, action: A) => S;
  type EffectCallback = () => void | (() => void);
  type DependencyList = readonly unknown[];

  function useState<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  function useReducer<S, A>(reducer: (prevState: S, action: A) => S, initialState: S): [S, Dispatch<A>];
  function useReducer<S, A, I>(reducer: (prevState: S, action: A) => S, initialArg: I, init: (i: I) => S): [S, Dispatch<A>];
  function useEffect(effect: EffectCallback, deps?: DependencyList): void;
  function useLayoutEffect(effect: EffectCallback, deps?: DependencyList): void;
  function useInsertionEffect(effect: EffectCallback, deps?: DependencyList): void;
  function useRef<T>(initialValue: T): RefObject<T>;
  function useRef<T>(initialValue: T | null): RefObject<T | null>;
  function useRef<T>(initialValue: T | undefined): RefObject<T | undefined>;
  function useMemo<T>(factory: () => T, deps: DependencyList): T;
  function useCallback<T extends Function>(callback: T, deps: DependencyList): T;
  function useContext<T>(context: Context<T>): T;
  function useId(): string;
  function useImperativeHandle<T, R extends T>(ref: Ref<T> | undefined, init: () => R, deps?: DependencyList): void;
  function useDebugValue<T>(value: T, format?: (value: T) => any): void;
  type TransitionFunction = () => void | Promise<void>;
  interface TransitionStartFunction {
    (callback: TransitionFunction): void;
  }
  function useTransition(): [boolean, TransitionStartFunction];
  function startTransition(scope: TransitionFunction): void;
  function useDeferredValue<T>(value: T, initialValue?: T): T;
  function useSyncExternalStore<Snapshot>(
    subscribe: (onStoreChange: () => void) => () => void,
    getSnapshot: () => Snapshot,
    getServerSnapshot?: () => Snapshot,
  ): Snapshot;
  function use<T>(usable: Promise<T> | Context<T>): T;

  // ── Element APIs ──
  function createElement<P extends {}>(type: string | JSXElementConstructor<P>, props?: P | null, ...children: ReactNode[]): ReactElement<P>;
  function cloneElement<P>(element: ReactElement<P>, props?: Partial<P> | null, ...children: ReactNode[]): ReactElement<P>;
  function isValidElement<P>(object: {} | null | undefined): object is ReactElement<P>;
  function createRef<T>(): RefObject<T | null>;
  function forwardRef<T, P = {}>(render: (props: P, ref: ForwardedRef<T>) => ReactNode): FunctionComponent<P & { ref?: Ref<T> }>;
  function memo<P extends object>(Component: FunctionComponent<P>, propsAreEqual?: (prev: Readonly<P>, next: Readonly<P>) => boolean): FunctionComponent<P>;
  function lazy<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>): T;

  const Fragment: FunctionComponent<{ children?: ReactNode; key?: Key | null }>;
  const StrictMode: FunctionComponent<{ children?: ReactNode }>;
  const Suspense: FunctionComponent<{ children?: ReactNode; fallback?: ReactNode }>;

  const Children: {
    map<T, C>(children: C | readonly C[], fn: (child: C, index: number) => T): C extends null | undefined ? C : Array<Exclude<T, boolean | null | undefined>>;
    forEach<C>(children: C | readonly C[], fn: (child: C, index: number) => void): void;
    count(children: any): number;
    only<C>(children: C): C extends any[] ? never : C;
    toArray(children: ReactNode | ReactNode[]): Array<Exclude<ReactNode, boolean | null | undefined>>;
  };

  // ── Events ──
  interface BaseSyntheticEvent<E = object, C = any, T = any> {
    nativeEvent: E;
    currentTarget: C;
    target: T;
    bubbles: boolean;
    cancelable: boolean;
    defaultPrevented: boolean;
    eventPhase: number;
    isTrusted: boolean;
    preventDefault(): void;
    isDefaultPrevented(): boolean;
    stopPropagation(): void;
    isPropagationStopped(): boolean;
    persist(): void;
    timeStamp: number;
    type: string;
  }
  interface SyntheticEvent<T = Element, E = Event> extends BaseSyntheticEvent<E, EventTarget & T, EventTarget> {}
  interface ClipboardEvent<T = Element> extends SyntheticEvent<T, NativeClipboardEvent> {
    clipboardData: DataTransfer;
  }
  interface CompositionEvent<T = Element> extends SyntheticEvent<T, NativeCompositionEvent> {
    data: string;
  }
  interface DragEvent<T = Element> extends MouseEvent<T, NativeDragEvent> {
    dataTransfer: DataTransfer;
  }
  interface FocusEvent<Target = Element, RelatedTarget = Element> extends SyntheticEvent<Target, NativeFocusEvent> {
    relatedTarget: (EventTarget & RelatedTarget) | null;
    target: EventTarget & Target;
  }
  interface FormEvent<T = Element> extends SyntheticEvent<T> {}
  interface InvalidEvent<T = Element> extends SyntheticEvent<T> {
    target: EventTarget & T;
  }
  interface ChangeEvent<T = Element> extends SyntheticEvent<T> {
    target: EventTarget & T;
  }
  interface KeyboardEvent<T = Element> extends UIEvent<T, NativeKeyboardEvent> {
    altKey: boolean;
    charCode: number;
    ctrlKey: boolean;
    code: string;
    getModifierState(key: string): boolean;
    key: string;
    keyCode: number;
    locale: string;
    location: number;
    metaKey: boolean;
    repeat: boolean;
    shiftKey: boolean;
    which: number;
  }
  interface MouseEvent<T = Element, E = NativeMouseEvent> extends UIEvent<T, E> {
    altKey: boolean;
    button: number;
    buttons: number;
    clientX: number;
    clientY: number;
    ctrlKey: boolean;
    getModifierState(key: string): boolean;
    metaKey: boolean;
    movementX: number;
    movementY: number;
    pageX: number;
    pageY: number;
    relatedTarget: EventTarget | null;
    screenX: number;
    screenY: number;
    shiftKey: boolean;
    detail: number;
  }
  interface PointerEvent<T = Element> extends MouseEvent<T, NativePointerEvent> {
    pointerId: number;
    pointerType: 'mouse' | 'pen' | 'touch';
    pressure: number;
    width: number;
    height: number;
    isPrimary: boolean;
  }
  interface UIEvent<T = Element, E = NativeUIEvent> extends SyntheticEvent<T, E> {
    detail: number;
    view: AbstractView;
  }
  interface AbstractView {
    styleMedia: StyleMedia;
    document: Document;
  }
  interface StyleMedia {
    type: string;
    matchMedium(mediaquery: string): boolean;
  }
  interface WheelEvent<T = Element> extends MouseEvent<T, NativeWheelEvent> {
    deltaMode: number;
    deltaX: number;
    deltaY: number;
    deltaZ: number;
  }
  interface TouchEvent<T = Element> extends UIEvent<T, NativeTouchEvent> {
    altKey: boolean;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
  }
  interface AnimationEvent<T = Element> extends SyntheticEvent<T, NativeAnimationEvent> {
    animationName: string;
    elapsedTime: number;
  }
  interface TransitionEvent<T = Element> extends SyntheticEvent<T, NativeTransitionEvent> {
    propertyName: string;
    elapsedTime: number;
  }

  type EventHandler<E extends SyntheticEvent<any>> = { bivarianceHack(event: E): void }['bivarianceHack'];
  type ReactEventHandler<T = Element> = EventHandler<SyntheticEvent<T>>;
  type ClipboardEventHandler<T = Element> = EventHandler<ClipboardEvent<T>>;
  type DragEventHandler<T = Element> = EventHandler<DragEvent<T>>;
  type FocusEventHandler<T = Element> = EventHandler<FocusEvent<T>>;
  type FormEventHandler<T = Element> = EventHandler<FormEvent<T>>;
  type ChangeEventHandler<T = Element> = EventHandler<ChangeEvent<T>>;
  type KeyboardEventHandler<T = Element> = EventHandler<KeyboardEvent<T>>;
  type MouseEventHandler<T = Element> = EventHandler<MouseEvent<T>>;
  type PointerEventHandler<T = Element> = EventHandler<PointerEvent<T>>;
  type UIEventHandler<T = Element> = EventHandler<UIEvent<T>>;
  type WheelEventHandler<T = Element> = EventHandler<WheelEvent<T>>;
  type TouchEventHandler<T = Element> = EventHandler<TouchEvent<T>>;
  type AnimationEventHandler<T = Element> = EventHandler<AnimationEvent<T>>;
  type TransitionEventHandler<T = Element> = EventHandler<TransitionEvent<T>>;
  type CompositionEventHandler<T = Element> = EventHandler<CompositionEvent<T>>;

  // ── DOM attributes ──
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
    alignItems?: string;
    alignSelf?: string;
    animation?: string;
    background?: string;
    backgroundColor?: string;
    border?: string;
    borderBottom?: string;
    borderColor?: string;
    borderLeft?: string;
    borderRadius?: string | number;
    borderRight?: string;
    borderTop?: string;
    bottom?: string | number;
    boxShadow?: string;
    color?: string;
    columnGap?: string | number;
    cursor?: string;
    display?: string;
    flex?: string | number;
    flexBasis?: string | number;
    flexDirection?: 'row' | 'column' | 'row-reverse' | 'column-reverse';
    flexGrow?: number;
    flexShrink?: number;
    flexWrap?: 'wrap' | 'nowrap' | 'wrap-reverse';
    fontFamily?: string;
    fontSize?: string | number;
    fontVariantNumeric?: string;
    fontWeight?: string | number;
    gap?: string | number;
    gridArea?: string;
    gridColumn?: string;
    gridRow?: string;
    gridTemplateAreas?: string;
    gridTemplateColumns?: string;
    gridTemplateRows?: string;
    height?: string | number;
    inset?: string | number;
    justifyContent?: string;
    justifyItems?: string;
    left?: string | number;
    letterSpacing?: string | number;
    lineHeight?: string | number;
    margin?: string | number;
    marginBottom?: string | number;
    marginInline?: string | number;
    marginLeft?: string | number;
    marginRight?: string | number;
    marginTop?: string | number;
    maxHeight?: string | number;
    maxWidth?: string | number;
    minHeight?: string | number;
    minWidth?: string | number;
    objectFit?: string;
    opacity?: number | string;
    order?: number;
    outline?: string;
    overflow?: string;
    overflowX?: string;
    overflowY?: string;
    padding?: string | number;
    paddingBottom?: string | number;
    paddingInline?: string | number;
    paddingLeft?: string | number;
    paddingRight?: string | number;
    paddingTop?: string | number;
    pointerEvents?: string;
    position?: 'static' | 'relative' | 'absolute' | 'fixed' | 'sticky';
    right?: string | number;
    rowGap?: string | number;
    stroke?: string;
    fill?: string;
    tableLayout?: string;
    textAlign?: 'left' | 'right' | 'center' | 'justify' | 'start' | 'end';
    textDecoration?: string;
    textOverflow?: string;
    textTransform?: string;
    top?: string | number;
    transform?: string;
    transition?: string;
    userSelect?: string;
    verticalAlign?: string;
    visibility?: string;
    whiteSpace?: string;
    width?: string | number;
    wordBreak?: string;
    zIndex?: number | string;
  }

  interface DOMAttributes<T> {
    children?: ReactNode | undefined;
    dangerouslySetInnerHTML?: { __html: string | TrustedHTML } | undefined;
    onCopy?: ClipboardEventHandler<T>;
    onCut?: ClipboardEventHandler<T>;
    onPaste?: ClipboardEventHandler<T>;
    onCompositionEnd?: CompositionEventHandler<T>;
    onCompositionStart?: CompositionEventHandler<T>;
    onFocus?: FocusEventHandler<T>;
    onBlur?: FocusEventHandler<T>;
    onChange?: FormEventHandler<T>;
    onBeforeInput?: FormEventHandler<T>;
    onInput?: FormEventHandler<T>;
    onReset?: FormEventHandler<T>;
    onSubmit?: FormEventHandler<T>;
    onInvalid?: FormEventHandler<T>;
    onLoad?: ReactEventHandler<T>;
    onError?: ReactEventHandler<T>;
    onKeyDown?: KeyboardEventHandler<T>;
    onKeyDownCapture?: KeyboardEventHandler<T>;
    onKeyUp?: KeyboardEventHandler<T>;
    onAuxClick?: MouseEventHandler<T>;
    onClick?: MouseEventHandler<T>;
    onClickCapture?: MouseEventHandler<T>;
    onContextMenu?: MouseEventHandler<T>;
    onDoubleClick?: MouseEventHandler<T>;
    onDrag?: DragEventHandler<T>;
    onDragEnd?: DragEventHandler<T>;
    onDragEnter?: DragEventHandler<T>;
    onDragLeave?: DragEventHandler<T>;
    onDragOver?: DragEventHandler<T>;
    onDragStart?: DragEventHandler<T>;
    onDrop?: DragEventHandler<T>;
    onMouseDown?: MouseEventHandler<T>;
    onMouseEnter?: MouseEventHandler<T>;
    onMouseLeave?: MouseEventHandler<T>;
    onMouseMove?: MouseEventHandler<T>;
    onMouseOut?: MouseEventHandler<T>;
    onMouseOver?: MouseEventHandler<T>;
    onMouseUp?: MouseEventHandler<T>;
    onPointerDown?: PointerEventHandler<T>;
    onPointerMove?: PointerEventHandler<T>;
    onPointerUp?: PointerEventHandler<T>;
    onPointerEnter?: PointerEventHandler<T>;
    onPointerLeave?: PointerEventHandler<T>;
    onScroll?: UIEventHandler<T>;
    onWheel?: WheelEventHandler<T>;
    onTouchStart?: TouchEventHandler<T>;
    onTouchEnd?: TouchEventHandler<T>;
    onAnimationEnd?: AnimationEventHandler<T>;
    onTransitionEnd?: TransitionEventHandler<T>;
  }

  type Booleanish = boolean | 'true' | 'false';
  type AriaRole = string;

  interface AriaAttributes {
    'aria-activedescendant'?: string;
    'aria-busy'?: Booleanish;
    'aria-checked'?: boolean | 'false' | 'mixed' | 'true';
    'aria-controls'?: string;
    'aria-current'?: boolean | 'false' | 'true' | 'page' | 'step' | 'location' | 'date' | 'time';
    'aria-describedby'?: string;
    'aria-disabled'?: Booleanish;
    'aria-expanded'?: Booleanish;
    'aria-haspopup'?: boolean | 'false' | 'true' | 'menu' | 'listbox' | 'tree' | 'grid' | 'dialog';
    'aria-hidden'?: Booleanish;
    'aria-invalid'?: boolean | 'false' | 'true' | 'grammar' | 'spelling';
    'aria-label'?: string;
    'aria-labelledby'?: string;
    'aria-live'?: 'off' | 'assertive' | 'polite';
    'aria-modal'?: Booleanish;
    'aria-multiselectable'?: Booleanish;
    'aria-orientation'?: 'horizontal' | 'vertical';
    'aria-pressed'?: boolean | 'false' | 'mixed' | 'true';
    'aria-readonly'?: Booleanish;
    'aria-required'?: Booleanish;
    'aria-selected'?: Booleanish;
    'aria-sort'?: 'none' | 'ascending' | 'descending' | 'other';
    'aria-valuemax'?: number;
    'aria-valuemin'?: number;
    'aria-valuenow'?: number;
    'aria-valuetext'?: string;
    'aria-autocomplete'?: 'none' | 'inline' | 'list' | 'both';
    'aria-rowcount'?: number;
    'aria-rowindex'?: number;
    'aria-colcount'?: number;
    'aria-colindex'?: number;
    'aria-level'?: number;
    'aria-posinset'?: number;
    'aria-setsize'?: number;
    'aria-errormessage'?: string;
    'aria-keyshortcuts'?: string;
    'aria-roledescription'?: string;
  }

  interface HTMLAttributes<T> extends AriaAttributes, DOMAttributes<T> {
    accessKey?: string;
    autoCapitalize?: string;
    autoFocus?: boolean;
    className?: string;
    contentEditable?: Booleanish | 'inherit' | 'plaintext-only';
    dir?: string;
    draggable?: Booleanish;
    enterKeyHint?: 'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send';
    hidden?: boolean;
    id?: string;
    inert?: boolean;
    lang?: string;
    nonce?: string;
    slot?: string;
    spellCheck?: Booleanish;
    style?: CSSProperties;
    tabIndex?: number;
    title?: string;
    translate?: 'yes' | 'no';
    role?: AriaRole;
    inputMode?: 'none' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | 'search';
    is?: string;
    popover?: '' | 'auto' | 'manual';
  }
  interface AllHTMLAttributes<T> extends HTMLAttributes<T> {
    [attr: string]: unknown;
  }

  interface AnchorHTMLAttributes<T> extends HTMLAttributes<T> {
    download?: any;
    href?: string;
    hrefLang?: string;
    rel?: string;
    target?: '_self' | '_blank' | '_parent' | '_top' | (string & {});
    type?: string;
  }
  interface ButtonHTMLAttributes<T> extends HTMLAttributes<T> {
    disabled?: boolean;
    form?: string;
    formAction?: string;
    name?: string;
    type?: 'submit' | 'reset' | 'button';
    value?: string | readonly string[] | number;
  }
  interface FormHTMLAttributes<T> extends HTMLAttributes<T> {
    acceptCharset?: string;
    action?: string;
    autoComplete?: string;
    encType?: string;
    method?: string;
    name?: string;
    noValidate?: boolean;
    target?: string;
  }
  type HTMLInputTypeAttribute =
    | 'button' | 'checkbox' | 'color' | 'date' | 'datetime-local' | 'email' | 'file' | 'hidden' | 'image'
    | 'month' | 'number' | 'password' | 'radio' | 'range' | 'reset' | 'search' | 'submit' | 'tel' | 'text'
    | 'time' | 'url' | 'week' | (string & {});
  interface InputHTMLAttributes<T> extends HTMLAttributes<T> {
    accept?: string;
    alt?: string;
    autoComplete?: string;
    capture?: boolean | 'user' | 'environment';
    checked?: boolean;
    defaultChecked?: boolean;
    defaultValue?: string | number | readonly string[];
    disabled?: boolean;
    form?: string;
    height?: number | string;
    list?: string;
    max?: number | string;
    maxLength?: number;
    min?: number | string;
    minLength?: number;
    multiple?: boolean;
    name?: string;
    pattern?: string;
    placeholder?: string;
    readOnly?: boolean;
    required?: boolean;
    size?: number;
    src?: string;
    step?: number | string;
    type?: HTMLInputTypeAttribute;
    value?: string | readonly string[] | number;
    width?: number | string;
    onChange?: ChangeEventHandler<T>;
  }
  interface LabelHTMLAttributes<T> extends HTMLAttributes<T> {
    form?: string;
    htmlFor?: string;
  }
  interface SelectHTMLAttributes<T> extends HTMLAttributes<T> {
    autoComplete?: string;
    disabled?: boolean;
    form?: string;
    multiple?: boolean;
    name?: string;
    required?: boolean;
    size?: number;
    value?: string | readonly string[] | number;
    defaultValue?: string | readonly string[] | number;
    onChange?: ChangeEventHandler<T>;
  }
  interface OptionHTMLAttributes<T> extends HTMLAttributes<T> {
    disabled?: boolean;
    label?: string;
    selected?: boolean;
    value?: string | readonly string[] | number;
  }
  interface OptgroupHTMLAttributes<T> extends HTMLAttributes<T> {
    disabled?: boolean;
    label?: string;
  }
  interface TextareaHTMLAttributes<T> extends HTMLAttributes<T> {
    autoComplete?: string;
    cols?: number;
    defaultValue?: string | number | readonly string[];
    disabled?: boolean;
    form?: string;
    maxLength?: number;
    minLength?: number;
    name?: string;
    placeholder?: string;
    readOnly?: boolean;
    required?: boolean;
    rows?: number;
    value?: string | readonly string[] | number;
    wrap?: string;
    onChange?: ChangeEventHandler<T>;
  }
  interface ImgHTMLAttributes<T> extends HTMLAttributes<T> {
    alt?: string;
    crossOrigin?: 'anonymous' | 'use-credentials' | '';
    decoding?: 'async' | 'auto' | 'sync';
    height?: number | string;
    loading?: 'eager' | 'lazy';
    sizes?: string;
    src?: string;
    srcSet?: string;
    width?: number | string;
  }
  interface TableHTMLAttributes<T> extends HTMLAttributes<T> {
    cellPadding?: number | string;
    cellSpacing?: number | string;
    summary?: string;
    width?: number | string;
  }
  interface TdHTMLAttributes<T> extends HTMLAttributes<T> {
    align?: 'left' | 'center' | 'right' | 'justify' | 'char';
    colSpan?: number;
    headers?: string;
    rowSpan?: number;
    scope?: string;
    valign?: 'top' | 'middle' | 'bottom' | 'baseline';
    width?: number | string;
  }
  interface ThHTMLAttributes<T> extends HTMLAttributes<T> {
    align?: 'left' | 'center' | 'right' | 'justify' | 'char';
    colSpan?: number;
    headers?: string;
    rowSpan?: number;
    scope?: string;
    abbr?: string;
  }
  interface ColHTMLAttributes<T> extends HTMLAttributes<T> {
    span?: number;
    width?: number | string;
  }
  interface ColgroupHTMLAttributes<T> extends HTMLAttributes<T> {
    span?: number;
  }
  interface DialogHTMLAttributes<T> extends HTMLAttributes<T> {
    onCancel?: ReactEventHandler<T>;
    onClose?: ReactEventHandler<T>;
    open?: boolean;
  }
  interface DetailsHTMLAttributes<T> extends HTMLAttributes<T> {
    open?: boolean;
    onToggle?: ReactEventHandler<T>;
  }
  interface IframeHTMLAttributes<T> extends HTMLAttributes<T> {
    allow?: string;
    height?: number | string;
    name?: string;
    sandbox?: string;
    src?: string;
    srcDoc?: string;
    width?: number | string;
  }
  interface ProgressHTMLAttributes<T> extends HTMLAttributes<T> {
    max?: number | string;
    value?: string | readonly string[] | number;
  }
  interface MeterHTMLAttributes<T> extends HTMLAttributes<T> {
    high?: number;
    low?: number;
    max?: number | string;
    min?: number | string;
    optimum?: number;
    value?: string | readonly string[] | number;
  }
  interface OlHTMLAttributes<T> extends HTMLAttributes<T> {
    reversed?: boolean;
    start?: number;
    type?: '1' | 'a' | 'A' | 'i' | 'I';
  }
  interface LiHTMLAttributes<T> extends HTMLAttributes<T> {
    value?: string | readonly string[] | number;
  }
  interface FieldsetHTMLAttributes<T> extends HTMLAttributes<T> {
    disabled?: boolean;
    form?: string;
    name?: string;
  }
  interface OutputHTMLAttributes<T> extends HTMLAttributes<T> {
    form?: string;
    htmlFor?: string;
    name?: string;
  }
  interface TimeHTMLAttributes<T> extends HTMLAttributes<T> {
    dateTime?: string;
  }
  interface CanvasHTMLAttributes<T> extends HTMLAttributes<T> {
    height?: number | string;
    width?: number | string;
  }

  interface SVGAttributes<T> extends AriaAttributes, DOMAttributes<T> {
    className?: string;
    color?: string;
    height?: number | string;
    id?: string;
    lang?: string;
    max?: number | string;
    min?: number | string;
    role?: AriaRole;
    style?: CSSProperties;
    tabIndex?: number;
    width?: number | string;
    focusable?: Booleanish | 'auto';
    clipPath?: string;
    clipRule?: number | string;
    cx?: number | string;
    cy?: number | string;
    d?: string;
    dominantBaseline?: string;
    dx?: number | string;
    dy?: number | string;
    fill?: string;
    fillOpacity?: number | string;
    fillRule?: 'nonzero' | 'evenodd' | 'inherit';
    fontFamily?: string;
    fontSize?: number | string;
    fontWeight?: number | string;
    gradientTransform?: string;
    gradientUnits?: string;
    markerEnd?: string;
    mask?: string;
    offset?: number | string;
    opacity?: number | string;
    points?: string;
    preserveAspectRatio?: string;
    r?: number | string;
    rx?: number | string;
    ry?: number | string;
    shapeRendering?: string;
    stopColor?: string;
    stopOpacity?: number | string;
    stroke?: string;
    strokeDasharray?: string | number;
    strokeDashoffset?: string | number;
    strokeLinecap?: 'butt' | 'round' | 'square' | 'inherit';
    strokeLinejoin?: 'miter' | 'round' | 'bevel' | 'inherit';
    strokeOpacity?: number | string;
    strokeWidth?: number | string;
    textAnchor?: string;
    transform?: string;
    vectorEffect?: string;
    viewBox?: string;
    x?: number | string;
    x1?: number | string;
    x2?: number | string;
    xmlns?: string;
    y?: number | string;
    y1?: number | string;
    y2?: number | string;
  }

  interface ClassAttributes<T> {
    key?: Key | null | undefined;
    ref?: Ref<T> | undefined;
  }
  type DetailedHTMLProps<E extends HTMLAttributes<T>, T> = ClassAttributes<T> & E;
  interface SVGProps<T> extends SVGAttributes<T>, ClassAttributes<T> {}
}

type NativeAnimationEvent = AnimationEvent;
type NativeClipboardEvent = ClipboardEvent;
type NativeCompositionEvent = CompositionEvent;
type NativeDragEvent = DragEvent;
type NativeFocusEvent = FocusEvent;
type NativeKeyboardEvent = KeyboardEvent;
type NativeMouseEvent = MouseEvent;
type NativeTouchEvent = TouchEvent;
type NativePointerEvent = PointerEvent;
type NativeTransitionEvent = TransitionEvent;
type NativeUIEvent = UIEvent;
type NativeWheelEvent = WheelEvent;

declare global {
  namespace JSX {
    type ElementType = string | React.JSXElementConstructor<any>;
    interface Element extends React.ReactElement<any, any> {}
    interface ElementClass extends React.Component<any> {
      render(): React.ReactNode;
    }
    interface ElementAttributesProperty {
      props: {};
    }
    interface ElementChildrenAttribute {
      children: {};
    }
    interface IntrinsicAttributes {
      key?: React.Key | null | undefined;
    }
    interface IntrinsicClassAttributes<T> {
      ref?: React.Ref<T> | undefined;
    }
    interface IntrinsicElements {
      a: React.DetailedHTMLProps<React.AnchorHTMLAttributes<HTMLAnchorElement>, HTMLAnchorElement>;
      abbr: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      address: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      article: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      aside: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      b: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      blockquote: React.DetailedHTMLProps<React.HTMLAttributes<HTMLQuoteElement>, HTMLQuoteElement>;
      body: React.DetailedHTMLProps<React.HTMLAttributes<HTMLBodyElement>, HTMLBodyElement>;
      br: React.DetailedHTMLProps<React.HTMLAttributes<HTMLBRElement>, HTMLBRElement>;
      button: React.DetailedHTMLProps<React.ButtonHTMLAttributes<HTMLButtonElement>, HTMLButtonElement>;
      canvas: React.DetailedHTMLProps<React.CanvasHTMLAttributes<HTMLCanvasElement>, HTMLCanvasElement>;
      caption: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      code: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      col: React.DetailedHTMLProps<React.ColHTMLAttributes<HTMLTableColElement>, HTMLTableColElement>;
      colgroup: React.DetailedHTMLProps<React.ColgroupHTMLAttributes<HTMLTableColElement>, HTMLTableColElement>;
      datalist: React.DetailedHTMLProps<React.HTMLAttributes<HTMLDataListElement>, HTMLDataListElement>;
      dd: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      del: React.DetailedHTMLProps<React.HTMLAttributes<HTMLModElement>, HTMLModElement>;
      details: React.DetailedHTMLProps<React.DetailsHTMLAttributes<HTMLDetailsElement>, HTMLDetailsElement>;
      dialog: React.DetailedHTMLProps<React.DialogHTMLAttributes<HTMLDialogElement>, HTMLDialogElement>;
      div: React.DetailedHTMLProps<React.HTMLAttributes<HTMLDivElement>, HTMLDivElement>;
      dl: React.DetailedHTMLProps<React.HTMLAttributes<HTMLDListElement>, HTMLDListElement>;
      dt: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      em: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      fieldset: React.DetailedHTMLProps<React.FieldsetHTMLAttributes<HTMLFieldSetElement>, HTMLFieldSetElement>;
      figcaption: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      figure: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      footer: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      form: React.DetailedHTMLProps<React.FormHTMLAttributes<HTMLFormElement>, HTMLFormElement>;
      h1: React.DetailedHTMLProps<React.HTMLAttributes<HTMLHeadingElement>, HTMLHeadingElement>;
      h2: React.DetailedHTMLProps<React.HTMLAttributes<HTMLHeadingElement>, HTMLHeadingElement>;
      h3: React.DetailedHTMLProps<React.HTMLAttributes<HTMLHeadingElement>, HTMLHeadingElement>;
      h4: React.DetailedHTMLProps<React.HTMLAttributes<HTMLHeadingElement>, HTMLHeadingElement>;
      h5: React.DetailedHTMLProps<React.HTMLAttributes<HTMLHeadingElement>, HTMLHeadingElement>;
      h6: React.DetailedHTMLProps<React.HTMLAttributes<HTMLHeadingElement>, HTMLHeadingElement>;
      head: React.DetailedHTMLProps<React.HTMLAttributes<HTMLHeadElement>, HTMLHeadElement>;
      header: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      hr: React.DetailedHTMLProps<React.HTMLAttributes<HTMLHRElement>, HTMLHRElement>;
      html: React.DetailedHTMLProps<React.HTMLAttributes<HTMLHtmlElement>, HTMLHtmlElement>;
      i: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      iframe: React.DetailedHTMLProps<React.IframeHTMLAttributes<HTMLIFrameElement>, HTMLIFrameElement>;
      img: React.DetailedHTMLProps<React.ImgHTMLAttributes<HTMLImageElement>, HTMLImageElement>;
      input: React.DetailedHTMLProps<React.InputHTMLAttributes<HTMLInputElement>, HTMLInputElement>;
      ins: React.DetailedHTMLProps<React.HTMLAttributes<HTMLModElement>, HTMLModElement>;
      kbd: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      label: React.DetailedHTMLProps<React.LabelHTMLAttributes<HTMLLabelElement>, HTMLLabelElement>;
      legend: React.DetailedHTMLProps<React.HTMLAttributes<HTMLLegendElement>, HTMLLegendElement>;
      li: React.DetailedHTMLProps<React.LiHTMLAttributes<HTMLLIElement>, HTMLLIElement>;
      main: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      mark: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      menu: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      meter: React.DetailedHTMLProps<React.MeterHTMLAttributes<HTMLMeterElement>, HTMLMeterElement>;
      nav: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      ol: React.DetailedHTMLProps<React.OlHTMLAttributes<HTMLOListElement>, HTMLOListElement>;
      optgroup: React.DetailedHTMLProps<React.OptgroupHTMLAttributes<HTMLOptGroupElement>, HTMLOptGroupElement>;
      option: React.DetailedHTMLProps<React.OptionHTMLAttributes<HTMLOptionElement>, HTMLOptionElement>;
      output: React.DetailedHTMLProps<React.OutputHTMLAttributes<HTMLOutputElement>, HTMLOutputElement>;
      p: React.DetailedHTMLProps<React.HTMLAttributes<HTMLParagraphElement>, HTMLParagraphElement>;
      pre: React.DetailedHTMLProps<React.HTMLAttributes<HTMLPreElement>, HTMLPreElement>;
      progress: React.DetailedHTMLProps<React.ProgressHTMLAttributes<HTMLProgressElement>, HTMLProgressElement>;
      q: React.DetailedHTMLProps<React.HTMLAttributes<HTMLQuoteElement>, HTMLQuoteElement>;
      s: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      section: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      select: React.DetailedHTMLProps<React.SelectHTMLAttributes<HTMLSelectElement>, HTMLSelectElement>;
      small: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      span: React.DetailedHTMLProps<React.HTMLAttributes<HTMLSpanElement>, HTMLSpanElement>;
      strong: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      style: React.DetailedHTMLProps<React.HTMLAttributes<HTMLStyleElement>, HTMLStyleElement>;
      sub: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      summary: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      sup: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      table: React.DetailedHTMLProps<React.TableHTMLAttributes<HTMLTableElement>, HTMLTableElement>;
      tbody: React.DetailedHTMLProps<React.HTMLAttributes<HTMLTableSectionElement>, HTMLTableSectionElement>;
      td: React.DetailedHTMLProps<React.TdHTMLAttributes<HTMLTableDataCellElement>, HTMLTableDataCellElement>;
      textarea: React.DetailedHTMLProps<React.TextareaHTMLAttributes<HTMLTextAreaElement>, HTMLTextAreaElement>;
      tfoot: React.DetailedHTMLProps<React.HTMLAttributes<HTMLTableSectionElement>, HTMLTableSectionElement>;
      th: React.DetailedHTMLProps<React.ThHTMLAttributes<HTMLTableHeaderCellElement>, HTMLTableHeaderCellElement>;
      thead: React.DetailedHTMLProps<React.HTMLAttributes<HTMLTableSectionElement>, HTMLTableSectionElement>;
      time: React.DetailedHTMLProps<React.TimeHTMLAttributes<HTMLTimeElement>, HTMLTimeElement>;
      title: React.DetailedHTMLProps<React.HTMLAttributes<HTMLTitleElement>, HTMLTitleElement>;
      tr: React.DetailedHTMLProps<React.HTMLAttributes<HTMLTableRowElement>, HTMLTableRowElement>;
      u: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      ul: React.DetailedHTMLProps<React.HTMLAttributes<HTMLUListElement>, HTMLUListElement>;
      var: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      wbr: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      // SVG
      svg: React.SVGProps<SVGSVGElement>;
      circle: React.SVGProps<SVGCircleElement>;
      clipPath: React.SVGProps<SVGClipPathElement>;
      defs: React.SVGProps<SVGDefsElement>;
      ellipse: React.SVGProps<SVGEllipseElement>;
      g: React.SVGProps<SVGGElement>;
      line: React.SVGProps<SVGLineElement>;
      linearGradient: React.SVGProps<SVGLinearGradientElement>;
      mask: React.SVGProps<SVGMaskElement>;
      path: React.SVGProps<SVGPathElement>;
      pattern: React.SVGProps<SVGPatternElement>;
      polygon: React.SVGProps<SVGPolygonElement>;
      polyline: React.SVGProps<SVGPolylineElement>;
      radialGradient: React.SVGProps<SVGRadialGradientElement>;
      rect: React.SVGProps<SVGRectElement>;
      stop: React.SVGProps<SVGStopElement>;
      symbol: React.SVGProps<SVGSymbolElement>;
      text: React.SVGProps<SVGTextElement>;
      tspan: React.SVGProps<SVGTSpanElement>;
      use: React.SVGProps<SVGUseElement>;
    }
  }
}
