export const usePathname = () => "/chronos/editor/p";
export const useRouter = () => ({ push: (u: string) => console.log("push", u), refresh() {}, back() {}, replace() {}, prefetch() {} });
export const useSearchParams = () => new URLSearchParams();
export const redirect = () => {};
export const notFound = () => {};
