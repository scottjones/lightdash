import {
    AllowedEmailDomains,
    isAllowedEmailDomainProjectRole,
    isAllowedEmailDomainsRole,
    OrganizationMemberRole,
    ProjectMemberRole,
} from '@lightdash/common';
import { Knex } from 'knex';
import {
    DbOrganizationAllowedEmailDomainProjects,
    DbOrganizationAllowedEmailDomains,
    OrganizationAllowedEmailDomainProjectsTableName,
    OrganizationAllowedEmailDomainsTableName,
} from '../database/entities/organizationsAllowedEmailDomains';

type Dependencies = {
    database: Knex;
};

export class OrganizationAllowedEmailDomainsModel {
    private database: Knex;

    constructor(dependencies: Dependencies) {
        this.database = dependencies.database;
    }

    static mapDbOrganizationAllowedEmailDomainsToOrganizationAllowedEmailDomains(
        dbOrganizationAllowedEmailDomains: DbOrganizationAllowedEmailDomains,
        dbOrganizationAllowedEmailDomainProjects: DbOrganizationAllowedEmailDomainProjects[],
    ): AllowedEmailDomains {
        return {
            organizationUuid:
                dbOrganizationAllowedEmailDomains.organization_uuid,
            emailDomains: dbOrganizationAllowedEmailDomains.email_domains,
            role: isAllowedEmailDomainsRole(
                dbOrganizationAllowedEmailDomains.role,
            )
                ? dbOrganizationAllowedEmailDomains.role
                : OrganizationMemberRole.MEMBER,
            projects: dbOrganizationAllowedEmailDomainProjects.map(
                ({ project_uuid, role }) => ({
                    projectUuid: project_uuid,
                    role: isAllowedEmailDomainProjectRole(role)
                        ? role
                        : ProjectMemberRole.VIEWER,
                }),
            ),
        };
    }

    async findAllowedEmailDomains(
        orgUuid: string,
    ): Promise<AllowedEmailDomains | undefined> {
        const [row] = await this.database(
            OrganizationAllowedEmailDomainsTableName,
        )
            .where('organization_uuid', orgUuid)
            .select('*');

        if (!row) {
            return undefined;
        }

        const allowedEmailDomainProjects = await this.database(
            OrganizationAllowedEmailDomainProjectsTableName,
        )
            .where('allowed_email_domains_uuid', row.allowed_email_domains_uuid)
            .select('*');

        return OrganizationAllowedEmailDomainsModel.mapDbOrganizationAllowedEmailDomainsToOrganizationAllowedEmailDomains(
            row,
            allowedEmailDomainProjects,
        );
    }

    async getAllowedEmailDomains(
        orgUuid: string,
    ): Promise<AllowedEmailDomains> {
        const allowedEmailDomains = await this.findAllowedEmailDomains(orgUuid);
        if (!allowedEmailDomains) {
            throw new Error('Allowed email domains not found');
        }
        return allowedEmailDomains;
    }

    async upsertAllowedEmailDomains(
        data: AllowedEmailDomains,
    ): Promise<AllowedEmailDomains> {
        await this.database.transaction(async (trx) => {
            const [allowedEmailDomain] = await trx(
                OrganizationAllowedEmailDomainsTableName,
            )
                .insert({
                    organization_uuid: data.organizationUuid,
                    email_domains: data.emailDomains,
                    role: data.role,
                })
                .onConflict('organization_uuid')
                .merge()
                .returning('*');

            if (!allowedEmailDomain) {
                throw new Error('Failed to upsert allowed email domains');
            }
            const insertPromises: Promise<unknown>[] = [];
            data.projects.forEach((project) => {
                insertPromises.push(
                    trx(OrganizationAllowedEmailDomainProjectsTableName)
                        .insert({
                            allowed_email_domains_uuid:
                                allowedEmailDomain.allowed_email_domains_uuid,
                            project_uuid: project.projectUuid,
                            role: project.role,
                        })
                        .onConflict([
                            'project_uuid',
                            'allowed_email_domains_uuid',
                        ])
                        .merge(),
                );
            });
            await Promise.all(insertPromises);
        });

        return this.getAllowedEmailDomains(data.organizationUuid);
    }
}
