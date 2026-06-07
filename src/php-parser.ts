import * as phpParserPkg from "php-parser";
import type { Node as CodePhpNode } from "php-parser";
const { Engine: PhpParserEngine } = phpParserPkg;

export { PhpParserEngine };
export interface PhpNode extends CodePhpNode {
  kind: string;
  [key: string]: any;
}
