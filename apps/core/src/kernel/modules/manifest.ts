export type ModuleManifest = {
  key: string;
  title: string;
  menu: { label: string; path: string; permission: string }[];
  permissions: string[];
  subscriptions: { event: string; consumer: string }[];
};
