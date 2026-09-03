import { describeLocale } from '../core/locale';
import { toPosixPath } from '../core/workspace';
import { omitEmpty, requireProject, type ToolContext } from './shared';

export type ProjectInfoLocale = {
  locale: string;
  name?: string;
  files: string[];
  keys: number;
  structure: string;
};

export type ProjectInfoResult = {
  root: string;
  keyFormat: string;
  locales: ProjectInfoLocale[];
  namespaces?: string[];
  totals: { locales: number; keys: number };
  config: {
    resourceGlob: string;
    codeGlob: string;
    ignoreGlobs: string[];
    structure: string;
    insertOrder: string;
    codeRegex: 'default' | 'custom';
    nsSeparator?: string;
  };
  warnings?: string[];
};

export async function toolProjectInfo(_args: Record<string, never> | object, ctx: ToolContext): Promise<ProjectInfoResult> {
  const project = await requireProject(ctx);
  const locales: ProjectInfoLocale[] = project.locales.map(locale => {
    const files = project.resources.filter(r => r.locale === locale);
    const kinds = new Set(files.map(f => f.structure.kind));
    return omitEmpty({
      locale,
      name: describeLocale(locale),
      files: files.map(f => f.relativePath),
      keys: project.localeKeys(locale).size,
      structure: kinds.size === 1 ? files[0].structure.kind : 'varies',
    });
  });

  return omitEmpty({
    root: toPosixPath(project.root),
    keyFormat: project.namespaced ? `namespace${project.nsSeparator}key` : 'key',
    locales,
    namespaces: project.namespaced ? project.namespaces : undefined,
    totals: { locales: project.locales.length, keys: project.allKeys().length },
    config: omitEmpty({
      resourceGlob: project.config.resourceGlob,
      codeGlob: project.config.codeGlob,
      ignoreGlobs: project.config.ignoreGlobs,
      structure: project.config.structurePreference,
      insertOrder: project.config.insertOrderStrategy,
      codeRegex: project.config.customCodeRegex ? ('custom' as const) : ('default' as const),
      nsSeparator: project.namespaced ? project.nsSeparator : undefined,
    }),
    warnings: project.warnings.map(w => w.message),
  });
}
