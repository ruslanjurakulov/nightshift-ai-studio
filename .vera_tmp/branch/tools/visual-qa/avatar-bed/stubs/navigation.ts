// Stand-in for next/navigation inside the test bed (there is no Next router here).
export const useRouter = () => ({ refresh() {}, push() {}, replace() {}, back() {}, forward() {}, prefetch() {} });
export const usePathname = () => "/bed";
export const useSearchParams = () => new URLSearchParams(location.search);
