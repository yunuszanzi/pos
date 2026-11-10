import type { Category } from "../../api/catalogueApi";

/** id -> "Balloons > Latex", ordered so a parent comes right before its children. Archived categories are kept so existing products still show a name. */
export function categoryLabels(categories: Category[]): Map<string, string> {
  const children = new Map<string | null, Category[]>();
  for (const category of categories) {
    const siblings = children.get(category.parentId) ?? [];
    siblings.push(category);
    children.set(category.parentId, siblings);
  }
  const labels = new Map<string, string>();
  const visit = (parentId: string | null, prefix: string) => {
    for (const category of (children.get(parentId) ?? []).sort((a, b) => a.name.localeCompare(b.name))) {
      const label = prefix ? `${prefix} > ${category.name}` : category.name;
      labels.set(category.id, label);
      visit(category.id, label);
    }
  };
  visit(null, "");
  return labels;
}
