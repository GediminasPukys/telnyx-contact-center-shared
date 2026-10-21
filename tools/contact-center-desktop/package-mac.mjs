import {packageDesktop, packageOptions} from './package-desktop.mjs';
await packageDesktop(packageOptions('darwin', process.argv.slice(2)));
