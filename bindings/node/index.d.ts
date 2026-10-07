type BaseNode = {
  type: string;
  named: boolean;
};

type ChildNode = {
  multiple: boolean;
  required: boolean;
  types: BaseNode[];
};

type NodeInfo =
  | (BaseNode & {
      subtypes: BaseNode[];
    })
  | (BaseNode & {
      fields: { [name: string]: ChildNode };
      children: ChildNode[];
    });

type Language = {
  language: unknown;
  nodeTypeInfo: NodeInfo[];
  parseOptions: (
    tree: BoundaryTree | null,
    source?: string,
    includedRanges?: BoundaryRange[],
  ) => { includedRanges: BoundaryRange[] } | undefined;
};

type BoundaryPoint = { row: number; column: number };
type BoundaryRange = {
  startIndex: number;
  endIndex: number;
  startPosition: BoundaryPoint;
  endPosition: BoundaryPoint;
};
type BoundaryTree = {
  rootNode: {
    endIndex: number;
    endPosition: BoundaryPoint;
    descendantsOfType: (type: string) => { endIndex: number; endPosition: BoundaryPoint }[];
  };
};

declare const language: Language;
export = language;
