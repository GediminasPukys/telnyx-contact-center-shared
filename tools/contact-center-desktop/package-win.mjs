import {packageDesktop, packageOptions} from './package-desktop.mjs';
await packageDesktop(packageOptions('win32', process.argv.slice(2)));
