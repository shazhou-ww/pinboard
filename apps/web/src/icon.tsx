import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { FolderPlusIcon } from "@phosphor-icons/react/dist/csr/FolderPlus";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { SignOutIcon } from "@phosphor-icons/react/dist/csr/SignOut";
import type { IconProps } from "@phosphor-icons/react";

const icons = {
  add: PlusIcon,
  addFolder: FolderPlusIcon,
  brand: PushPinIcon,
  caretDown: CaretDownIcon,
  check: CheckIcon,
  copy: CopyIcon,
  download: ArrowDownIcon,
  externalLink: ArrowUpRightIcon,
  file: FileTextIcon,
  folder: FolderIcon,
  more: DotsThreeIcon,
  settings: GearIcon,
  signOut: SignOutIcon,
  unknown: QuestionIcon,
};

export function Icon({
  name,
  ...props
}: IconProps & { name: keyof typeof icons }) {
  const Glyph = icons[name];
  return (
    <Glyph
      size={20}
      weight="duotone"
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}
