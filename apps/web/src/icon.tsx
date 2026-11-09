import { ArrowDownIcon } from "@phosphor-icons/react/dist/csr/ArrowDown";
import { ArrowUpRightIcon } from "@phosphor-icons/react/dist/csr/ArrowUpRight";
import { CaretDownIcon } from "@phosphor-icons/react/dist/csr/CaretDown";
import { CaretLeftIcon } from "@phosphor-icons/react/dist/csr/CaretLeft";
import { CaretRightIcon } from "@phosphor-icons/react/dist/csr/CaretRight";
import { CheckIcon } from "@phosphor-icons/react/dist/csr/Check";
import { CopyIcon } from "@phosphor-icons/react/dist/csr/Copy";
import { DotsThreeIcon } from "@phosphor-icons/react/dist/csr/DotsThree";
import { FileTextIcon } from "@phosphor-icons/react/dist/csr/FileText";
import { FilePdfIcon } from "@phosphor-icons/react/dist/csr/FilePdf";
import { ImageIcon } from "@phosphor-icons/react/dist/csr/Image";
import { FilmStripIcon } from "@phosphor-icons/react/dist/csr/FilmStrip";
import { MusicNoteIcon } from "@phosphor-icons/react/dist/csr/MusicNote";
import { FolderIcon } from "@phosphor-icons/react/dist/csr/Folder";
import { FolderPlusIcon } from "@phosphor-icons/react/dist/csr/FolderPlus";
import { GearIcon } from "@phosphor-icons/react/dist/csr/Gear";
import { PlusIcon } from "@phosphor-icons/react/dist/csr/Plus";
import { PushPinIcon } from "@phosphor-icons/react/dist/csr/PushPin";
import { QuestionIcon } from "@phosphor-icons/react/dist/csr/Question";
import { SignOutIcon } from "@phosphor-icons/react/dist/csr/SignOut";
import { StackIcon } from "@phosphor-icons/react/dist/csr/Stack";
import { WarningIcon } from "@phosphor-icons/react/dist/csr/Warning";
import { XIcon } from "@phosphor-icons/react/dist/csr/X";
import { FunnelSimpleIcon } from "@phosphor-icons/react/dist/csr/FunnelSimple";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react/dist/csr/ArrowsClockwise";
import { XCircleIcon } from "@phosphor-icons/react/dist/csr/XCircle";
import type { IconProps } from "@phosphor-icons/react";

const icons = {
  add: PlusIcon,
  addFolder: FolderPlusIcon,
  brand: PushPinIcon,
  caretDown: CaretDownIcon,
  caretLeft: CaretLeftIcon,
  caretRight: CaretRightIcon,
  check: CheckIcon,
  close: XIcon,
  filter: FunnelSimpleIcon,
  refresh: ArrowsClockwiseIcon,
  revoke: XCircleIcon,
  copy: CopyIcon,
  download: ArrowDownIcon,
  externalLink: ArrowUpRightIcon,
  file: FileTextIcon,
  pdf: FilePdfIcon,
  image: ImageIcon,
  video: FilmStripIcon,
  audio: MusicNoteIcon,
  folder: FolderIcon,
  more: DotsThreeIcon,
  settings: GearIcon,
  signOut: SignOutIcon,
  unknown: QuestionIcon,
  publication: StackIcon,
  warning: WarningIcon,
};

export function Icon({
  name,
  ...props
}: IconProps & { name: keyof typeof icons }) {
  const Glyph = icons[name];
  return (
    <Glyph
      size={20}
      weight={
        name === "file" ||
        name === "folder" ||
        name === "unknown" ||
        name === "brand"
          ? "duotone"
          : "regular"
      }
      aria-hidden="true"
      focusable="false"
      {...props}
    />
  );
}
