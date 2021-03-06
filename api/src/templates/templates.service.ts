import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { findBestMatch } from 'string-similarity';
import { get, isArray, set } from 'lodash';
import { Model } from 'mongoose';
import { Report } from 'src/reports/interfaces/report.interface';
import { Template } from './interfaces/template.interface';
import {
  IdParamDto,
  SaveTemplateDto,
  EditTemplateBodyDto,
} from './dto/templates.dto';
import { Issue } from 'src/issues/interfaces/issue.interface';
import { SlackService } from 'src/plugins/slack/slack.service';
import { Unit } from 'src/units/interfaces/unit.interface';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class TemplatesService {
  constructor(
    @InjectModel('Report') private readonly reportModel: Model<Report>,
    @InjectModel('Template') private readonly templateModel: Model<Template>,
    @InjectModel('Unit') private readonly unitsModel: Model<Unit>,
    @InjectModel('Issue') private readonly issueModel: Model<Issue>,
    private readonly slackService: SlackService,
    private readonly configService: ConfigService
  ) {}

  async save(saveTemplateDto: SaveTemplateDto) {
    const template = await new this.templateModel(saveTemplateDto).save();
    const report = await this.reportModel.findOne({
      _id: saveTemplateDto.report,
    });

    await this.apply(report, template);

    return { id: template._id };
  }

  async apply(report: Report, template: Template) {
    const rep = report;
    const content = JSON.parse(report.content);
    const issues =
      template.path_to_issues !== ''
        ? get(content, template.path_to_issues)
        : content;

    const stat = await this.saveIssues(issues, template, report);

    rep.statistics = stat;
    rep.template = template._id;

    return rep.save();
  }

  async saveIssues(issues: object[], template: Template, report: Report) {
    let newOnes = 0;

    const allIssuesInUnit = await this.issueModel.find({ unit: report.unit });
    const allTemplateIssuesInUnit = await this.issueModel.find({
      unit: report.unit,
      template: template._id,
    });

    for (const issue of issues) {
      // Do external comparison first to avoid duplicate issues between templates
      let filteredUnitIssues = allIssuesInUnit;
      for (const comparisonField of template.external_comparison_fields) {
        filteredUnitIssues = filteredUnitIssues.filter(existingIssue =>
          existingIssue.fields.toLowerCase().includes(get(issue, comparisonField).toLowerCase())
        );
      }

      // There are no issues similar to the new one in the unit, move to the template comparison
      if (filteredUnitIssues.length === 0) {
        let filteredTemplateIssues = allTemplateIssuesInUnit;
        for (const comparisonField of template.internal_comparison_fields) {
          filteredTemplateIssues = filteredTemplateIssues.filter(
            existingIssue =>
              get(JSON.parse(existingIssue.fields), comparisonField) ===
              get(issue, comparisonField)
          );
        }

        // There is an issue similar to the new one
        if (filteredTemplateIssues.length && template.merge_fields.length) {
          const issueToUpdate = filteredTemplateIssues[0];
          const oldIssue = JSON.parse(issueToUpdate.fields);

          for (const field of template.merge_fields) {
            let originalField = get(oldIssue, field);
            const newField = get(issue, field);

            if (originalField) {
              if (
                typeof originalField === 'string' &&
                !originalField.toLowerCase().includes(newField.toLowerCase())
              ) {
                originalField += `\n${newField}`;
              } else if (isArray(originalField)) {
                originalField = [...new Set([...originalField, ...newField])];
              }
            }

            set(oldIssue, field, originalField);
          }

          await this.issueModel.updateOne(
            { _id: issueToUpdate._id },
            { $set: { fields: JSON.stringify(oldIssue) } }
          );
        } else {
          const newIssue = await new this.issueModel({
            unit: report.unit,
            template: template._id,
            fields: JSON.stringify(issue),
            report: report._id,
          }).save();

          newOnes += 1;
          allTemplateIssuesInUnit.push(newIssue);
          allIssuesInUnit.push(newIssue);
        }
      }
    }

    if (newOnes > 0) {
      const unit = await this.unitsModel.findOne({ _id: report.unit });
      await this.slackService.sendMsg(
        `🆕 You have *${newOnes}* new issues\n📄 Template: ${
          template.name
        }\n🗃️ Unit: ${
          unit.name
        }\n👀 Take a look at them <https://${this.configService.get<string>(
          'DOMAIN'
        )}/#/unit/${unit.slug}/issues|*here*>`
      );
    }

    return {
      new: newOnes,
      old: issues.length - newOnes,
    };
  }

  async findAll() {
    const templates = await this.templateModel.find();
    const result = [];

    for (const template of templates) {
      const numberOfIsues = await this.issueModel.countDocuments({
        template: template._id,
      });
      const numberOfReports = await this.reportModel.countDocuments({
        template: template._id,
      });

      result.push({
        template,
        issues: numberOfIsues,
        reports: numberOfReports,
      });
    }

    return result;
  }

  async updateOne(templateId: string, template: EditTemplateBodyDto) {
    const oldTemplate = await this.templateModel.findOne({ _id: templateId });
    if (oldTemplate) {
      return this.templateModel.updateOne({ _id: templateId }, template);
    } else {
      throw new NotFoundException();
    }
  }

  async deleteOne() {
    throw new Error('Not implemented');
  }
}
