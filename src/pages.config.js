import Home from './pages/Home';
import __Layout from './Layout.jsx';


// Pages served at /<name>. The room page has its own route in App.jsx: /room/<code>.
export const PAGES = {
    "Home": Home,
}

export const pagesConfig = {
    mainPage: "Home",
    Pages: PAGES,
    Layout: __Layout,
};