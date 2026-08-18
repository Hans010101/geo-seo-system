import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export { index, text, uniqueIndex };
export const mysqlTable = sqliteTable;
export const varchar = (name: string, _options?: unknown) => text(name);
export const mediumtext = text;
export const boolean = (name: string) => integer(name, { mode: "boolean" });
export const json = (name: string) => text(name, { mode: "json" });
export const bigint = (name: string, _options?: unknown) => integer(name, { mode: "number" });
export const decimal = (name: string, _options?: unknown) => text(name);
export const mysqlEnum = <T extends readonly [string, ...string[]]>(name: string, values: T) =>
  text(name, { enum: values });

export const timestamp = (name: string) => {
  const column: any = integer(name, { mode: "timestamp" });
  column.defaultNow = () => {
    const withDefault: any = column.default(sql`(unixepoch())`);
    withDefault.onUpdateNow = () => withDefault.$onUpdate(() => new Date());
    return withDefault;
  };
  return column;
};

export const int = (name: string) => {
  const column: any = integer(name);
  column.autoincrement = () => {
    const primary: any = integer(name).primaryKey({ autoIncrement: true });
    primary.primaryKey = () => primary;
    return primary;
  };
  return column;
};
