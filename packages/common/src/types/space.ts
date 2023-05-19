import { get } from 'http';
import { DashboardBasicDetails } from './dashboard';
import { ProjectMemberRole } from './projectMemberProfile';
import { SpaceQuery } from './savedCharts';

export type Space = {
    organizationUuid: string;
    uuid: string;
    name: string;
    isPrivate: boolean;
    queries: SpaceQuery[];
    projectUuid: string;
    dashboards: DashboardBasicDetails[];
    access: SpaceShare[];
    pinnedListUuid: string | null;
    pinnedListOrder: number | null;
};

export type SpaceSummary = Pick<
    Space,
    'organizationUuid' | 'projectUuid' | 'uuid' | 'name' | 'isPrivate'
> & {
    access: string[];
};

export type CreateSpace = Pick<Space, 'name' | 'isPrivate' | 'access'>;

export type UpdateSpace = Pick<Space, 'name' | 'isPrivate'>;

export type SpaceShare = {
    userUuid: string;
    firstName: string;
    lastName: string;
    role: ProjectMemberRole | null;
};

export type ApiSpaceSummaryListResponse = {
    status: 'ok';
    results: SpaceSummary[];
};

export const getSpaceAccessFromSummary = (
    summary: SpaceSummary,
): Pick<
    Space,
    'isPrivate' | 'access' | 'organizationUuid' | 'projectUuid'
> => ({
    isPrivate: summary.isPrivate,
    access: summary.access.map((access) => ({
        userUuid: access,
        role: ProjectMemberRole.VIEWER,
        firstName: '',
        lastName: '',
    })),
    organizationUuid: summary.organizationUuid,
    projectUuid: summary.projectUuid,
});
